from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import argparse
import stat
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "dbz-crew"
LOADER = importlib.machinery.SourceFileLoader("dbz_crew", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
CREW = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(CREW)


def completed(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class CrewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "home"
        self.home.mkdir(mode=0o700)
        self.state_root = self.home / ".local" / "state" / "dbz-crew"
        self.account_home = mock.patch.object(CREW, "account_home", return_value=self.home)
        self.account_home.start()
        self.addCleanup(self.account_home.stop)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "DBZ_CREW_STATE_DIR": str(Path(self.temporary.name) / "ignored-state"),
                "XDG_STATE_HOME": str(Path(self.temporary.name) / "ignored-xdg"),
                "PI_PROVIDER": "openai-codex",
                "PI_MODEL": "gpt-test",
                "PI_REASONING_LEVEL": "high",
                "PI_SESSION_ID": "session-test",
            },
            clear=False,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def git(self, repository: Path, *args: str) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=repository,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result.stdout.strip()

    def create_repository(self, name: str = "repo") -> Path:
        repository = Path(self.temporary.name) / name
        repository.mkdir()
        self.git(repository, "init", "-b", "main")
        self.git(repository, "config", "user.name", "DBZ Crew Test")
        self.git(repository, "config", "user.email", "dbz-crew@example.invalid")
        return repository

    def test_state_root_is_literal_and_ignores_environment_overrides(self) -> None:
        self.assertEqual(CREW.state_root(), self.state_root)
        self.assertNotEqual(CREW.state_root(), Path(os.environ["DBZ_CREW_STATE_DIR"]))
        self.assertNotEqual(CREW.state_root().parent, Path(os.environ["XDG_STATE_HOME"]))

    def test_safe_state_root_permissions_are_repaired(self) -> None:
        (self.home / ".local").mkdir(mode=0o700)
        self.state_root.parent.mkdir(mode=0o700)
        self.state_root.mkdir(mode=0o755)
        os.chmod(self.state_root, 0o755)

        CREW.ensure_private_directory(self.state_root)

        self.assertEqual(stat.S_IMODE(self.state_root.stat().st_mode), 0o700)

    def test_symlinked_state_root_is_rejected_without_altering_target(self) -> None:
        (self.home / ".local").mkdir(mode=0o700)
        self.state_root.parent.mkdir(mode=0o700)
        target = Path(self.temporary.name) / "unexpected-target"
        target.mkdir(mode=0o755)
        os.chmod(target, 0o755)
        self.state_root.symlink_to(target, target_is_directory=True)

        with self.assertRaisesRegex(CREW.CrewError, "symbolic link"):
            CREW.ensure_private_directory(self.state_root)

        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)

    def test_symlinked_state_child_and_file_are_rejected(self) -> None:
        CREW.ensure_private_directory(self.state_root)
        external_directory = Path(self.temporary.name) / "external-results"
        external_directory.mkdir()
        results = self.state_root / "results"
        results.symlink_to(external_directory, target_is_directory=True)

        with self.assertRaisesRegex(CREW.CrewError, "symbolic link"):
            CREW.write_private_text(results / "pane" / "result.md", "unexpected\n")
        self.assertEqual(list(external_directory.iterdir()), [])

        results.unlink()
        result_directory = results / "pane"
        CREW.ensure_private_directory(result_directory)
        external_file = Path(self.temporary.name) / "external-file"
        external_file.write_text("preserve\n", encoding="utf-8")
        result_file = result_directory / "result.md"
        result_file.symlink_to(external_file)

        with self.assertRaisesRegex(CREW.CrewError, "symbolic link"):
            CREW.write_private_text(result_file, "unexpected\n")
        self.assertEqual(external_file.read_text(encoding="utf-8"), "preserve\n")

    def test_symlinked_state_lock_is_rejected_without_touching_target(self) -> None:
        path = CREW.state_path("pane:test")
        CREW.ensure_private_directory(path.parent)
        target = Path(self.temporary.name) / "lock-target"
        target.write_text("preserve\n", encoding="utf-8")
        os.chmod(target, 0o644)
        lock_path = path.with_suffix(f"{path.suffix}.lock")
        lock_path.symlink_to(target)

        with self.assertRaisesRegex(CREW.CrewError, "lock cannot be a symbolic link"):
            with CREW.state_lock(path):
                pass

        self.assertEqual(target.read_text(encoding="utf-8"), "preserve\n")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)

    def test_repository_local_state_root_is_rejected_before_creation(self) -> None:
        self.git(self.home, "init", "-b", "main")

        with self.assertRaisesRegex(CREW.CrewError, "inside a Git worktree"):
            CREW.ensure_private_directory(self.state_root)

        self.assertFalse(self.state_root.exists())

    def test_state_directory_owned_by_another_uid_is_rejected_without_changes(self) -> None:
        original_mode = stat.S_IMODE(self.home.stat().st_mode)
        with mock.patch.object(CREW.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(CREW.CrewError, "not owned by the current user"):
                CREW.ensure_private_directory(self.state_root)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), original_mode)
        self.assertFalse(self.state_root.exists())

    def test_pi_worker_configuration_uses_environment_and_explicit_overrides(self) -> None:
        self.assertEqual(
            CREW.pi_worker_configuration(),
            {"provider": "openai-codex", "model": "gpt-test", "thinking": "high"},
        )
        self.assertEqual(
            CREW.pi_worker_configuration({"model": "gpt-override"}),
            {"provider": "openai-codex", "model": "gpt-override", "thinking": "high"},
        )

    def test_pi_worker_configuration_rejects_missing_or_invalid_metadata(self) -> None:
        with mock.patch.dict(os.environ, {"PI_MODEL": "", "PI_REASONING_LEVEL": "extreme"}):
            with self.assertRaisesRegex(CREW.CrewError, "missing Pi worker metadata: model"):
                CREW.pi_worker_configuration()
        with self.assertRaisesRegex(CREW.CrewError, "thinking must be one of"):
            CREW.pi_worker_configuration({"thinking": "extreme"})

    def test_worker_start_command_passes_pi_runtime_configuration(self) -> None:
        config = CREW.pi_worker_configuration()
        self.assertEqual(
            CREW.worker_start_command("crew-test", "pane:2", config),
            [
                "herdr",
                "agent",
                "start",
                "crew-test",
                "--kind",
                "pi",
                "--pane",
                "pane:2",
                "--timeout",
                "30000",
                "--",
                "--provider",
                "openai-codex",
                "--model",
                "gpt-test",
                "--thinking",
                "high",
            ],
        )

    def test_monitor_launch_does_not_propagate_state_environment(self) -> None:
        prompt = CREW.task_path("pane:main", "worker-one")
        with mock.patch.object(CREW, "command", return_value=completed()) as run:
            CREW.launch_monitor(
                "pane:monitor",
                "pane:main",
                "crew-worker-one",
                "worker-one",
                prompt,
                "session-test",
            )

        arguments = run.call_args.args[0]
        self.assertEqual(arguments[:4], ["herdr", "pane", "run", "pane:monitor"])
        self.assertNotIn("env", arguments)
        self.assertFalse(any("DBZ_CREW_STATE_DIR" in argument for argument in arguments))

    def test_idle_worker_state_is_normalized_to_done(self) -> None:
        self.assertEqual(CREW.event_status('{"result":{"agent_status":"idle"}}'), "done")
        self.assertEqual(CREW.event_status('{"result":{"agent_status":"blocked"}}'), "blocked")

    def test_codex_plugin_install_subcommand_is_removed(self) -> None:
        result = subprocess.run(
            [str(SCRIPT), "install"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid choice", result.stderr)

    def test_pi_integration_status_accepts_current_and_legacy_installed(self) -> None:
        cases = (
            ("pi: current (v6) (/home/test/.pi/agent/extensions/herdr-agent-state.ts)\n", True),
            ("pi: installed (version 6)\n", True),
            ("pi: not installed (/home/test/.pi/agent/extensions/herdr-agent-state.ts)\n", False),
        )
        for output, expected in cases:
            with self.subTest(output=output), mock.patch.object(
                CREW,
                "command",
                return_value=completed(stdout=output),
            ):
                self.assertEqual(CREW.pi_integration_installed(), expected)

    def test_pi_preflight_uses_capabilities_and_active_event_bridge(self) -> None:
        repository = Path(self.temporary.name) / "repo"
        repository.mkdir()
        CREW.write_json(
            CREW.principal_ready_path("session-test"),
            {"session_id": "session-test", "pid": os.getpid()},
        )

        def fake_command(args: list[str], cwd: Path | None = None):
            key = tuple(args)
            if key == ("git", "rev-parse", "--show-toplevel"):
                return completed(stdout=f"{repository}\n")
            if key == ("git", "branch", "--show-current"):
                return completed(stdout="main\n")
            if key in {
                ("git", "rev-parse", "--verify", "main"),
                ("git", "rev-parse", "HEAD"),
            }:
                return completed(stdout="abc123\n")
            if key == ("git", "status", "--porcelain"):
                return completed()
            if key[:4] == ("git", "rev-parse", "-q", "--verify"):
                return completed(returncode=1)
            if key == ("herdr", "status", "server"):
                return completed()
            if key == ("herdr", "agent", "start", "--help"):
                return completed(stdout="possible values: pi\n")
            if key == ("herdr", "integration", "status"):
                return completed(stdout="pi: current (v6) (/home/test/.pi/agent/extensions/herdr-agent-state.ts)\n")
            raise AssertionError(f"unexpected command: {args}")

        pane = {
            "agent": "pi",
            "pane_id": "pane:main",
            "workspace_id": "workspace:main",
            "cwd": str(repository),
        }
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "current_pane", return_value=pane),
            mock.patch.object(CREW.shutil, "which", side_effect=lambda name: f"/bin/{name}"),
        ):
            result = CREW.preflight(repository)

        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["principal_agent"], "pi")
        self.assertEqual(result["principal_session_id"], "session-test")
        self.assertEqual(result["worker_config"]["model"], "gpt-test")

    def test_workflow_adapter_preflight_allows_a_dirty_workflow_branch_without_weakening_default_preflight(self) -> None:
        repository = Path(self.temporary.name) / "workflow-preflight-repo"
        repository.mkdir()
        CREW.write_json(
            CREW.principal_ready_path("workflow-session"),
            {"session_id": "workflow-session", "pid": os.getpid()},
        )
        CREW.write_json(
            CREW.principal_ready_path("session-test"),
            {"session_id": "session-test", "pid": os.getpid()},
        )

        def fake_command(args: list[str], cwd: Path | None = None):
            key = tuple(args)
            if key == ("git", "rev-parse", "--show-toplevel"):
                return completed(stdout=f"{repository}\n")
            if key == ("git", "branch", "--show-current"):
                return completed(stdout="dbz-workflows/WF-0001-example\n")
            if key == ("git", "rev-parse", "HEAD"):
                return completed(stdout="abc123\n")
            if key == ("git", "rev-parse", "--verify", "main"):
                return completed(stdout="def456\n")
            if key == ("git", "status", "--porcelain"):
                return completed(stdout=" M dbz-workflows/ticket.md\n")
            if key[:4] == ("git", "rev-parse", "-q", "--verify"):
                return completed(returncode=1)
            if key == ("herdr", "status", "server"):
                return completed()
            if key == ("herdr", "agent", "start", "--help"):
                return completed(stdout="possible values: pi\n")
            if key == ("herdr", "integration", "status"):
                return completed(stdout="pi: current (v6) (/tmp/herdr-agent-state.ts)\n")
            raise AssertionError(f"unexpected command: {args}")

        pane = {
            "agent": "pi",
            "pane_id": "pane:workflow",
            "workspace_id": "workspace:main",
            "cwd": str(repository),
        }
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "current_pane", return_value=pane),
            mock.patch.object(CREW.shutil, "which", side_effect=lambda name: f"/bin/{name}"),
        ):
            adapted = CREW.preflight(
                repository,
                workflow_adapter=True,
                principal_session_id="workflow-session",
            )
            ordinary = CREW.preflight(repository)

        self.assertTrue(adapted["ok"], adapted["errors"])
        self.assertTrue(adapted["dirty"])
        self.assertEqual(adapted["branch"], "dbz-workflows/WF-0001-example")
        self.assertEqual(adapted["principal_session_id"], "workflow-session")
        self.assertFalse(ordinary["ok"])
        self.assertIn("current branch must be main", ordinary["errors"])
        self.assertIn("main worktree must be clean, including untracked files", ordinary["errors"])

    def test_codex_principal_is_rejected(self) -> None:
        repository = Path(self.temporary.name) / "unsupported-agent-repo"
        repository.mkdir()

        def fake_command(args: list[str], cwd: Path | None = None):
            key = tuple(args)
            if key == ("git", "rev-parse", "--show-toplevel"):
                return completed(stdout=f"{repository}\n")
            if key == ("git", "branch", "--show-current"):
                return completed(stdout="main\n")
            if key in {
                ("git", "rev-parse", "--verify", "main"),
                ("git", "rev-parse", "HEAD"),
            }:
                return completed(stdout="abc123\n")
            if key == ("git", "status", "--porcelain"):
                return completed()
            if key[:4] == ("git", "rev-parse", "-q", "--verify"):
                return completed(returncode=1)
            if key == ("herdr", "status", "server"):
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        pane = {
            "agent": "codex",
            "pane_id": "pane:unsupported",
            "workspace_id": "workspace:main",
            "cwd": str(repository),
        }
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "current_pane", return_value=pane),
            mock.patch.object(CREW.shutil, "which", side_effect=lambda name: f"/bin/{name}"),
        ):
            result = CREW.preflight(repository)

        self.assertFalse(result["ok"])
        self.assertIn("current Herdr pane must be a Pi agent", result["errors"])
        self.assertIsNone(result["principal_agent"])
        self.assertIsNone(result["worker_config"])

    def test_read_only_option_validation(self) -> None:
        CREW.validate_read_only_options(True, False, False, None, allow_mutable_base=False)
        CREW.validate_read_only_options(True, False, True, "feature", allow_mutable_base=False)
        CREW.validate_read_only_options(True, True, False, None, allow_mutable_base=False)
        CREW.validate_read_only_options(False, False, False, "feature", allow_mutable_base=True)
        with self.assertRaisesRegex(CREW.CrewError, "--in-place requires"):
            CREW.validate_read_only_options(False, True, False, None, allow_mutable_base=False)
        with self.assertRaisesRegex(CREW.CrewError, "cannot be combined"):
            CREW.validate_read_only_options(True, True, True, None, allow_mutable_base=False)
        with self.assertRaisesRegex(CREW.CrewError, "--base requires --committed-only"):
            CREW.validate_read_only_options(True, False, False, "feature", allow_mutable_base=False)
        with self.assertRaisesRegex(CREW.CrewError, "invalid read-only base"):
            CREW.validate_read_only_options(True, False, True, "--help", allow_mutable_base=False)

    def test_read_only_preflight_allows_dirty_non_main_worktree(self) -> None:
        repository = Path(self.temporary.name) / "read-only-repo"
        repository.mkdir()
        CREW.write_json(
            CREW.principal_ready_path("session-test"),
            {"session_id": "session-test", "pid": os.getpid()},
        )

        def fake_command(args: list[str], cwd: Path | None = None):
            key = tuple(args)
            if key == ("git", "rev-parse", "--show-toplevel"):
                return completed(stdout=f"{repository}\n")
            if key == ("git", "branch", "--show-current"):
                return completed(stdout="feature\n")
            if key == ("git", "rev-parse", "HEAD"):
                return completed(stdout="abc123\n")
            if key == ("git", "rev-parse", "--verify", "release^{commit}"):
                return completed(stdout="def456\n")
            if key == ("git", "status", "--porcelain"):
                return completed(stdout=" M README.md\n?? local.txt\n")
            if key[:4] == ("git", "rev-parse", "-q", "--verify"):
                return completed(returncode=1)
            if key == ("herdr", "status", "server"):
                return completed()
            if key == ("herdr", "agent", "start", "--help"):
                return completed(stdout="possible values: pi\n")
            if key == ("herdr", "integration", "status"):
                return completed(stdout="pi: current (v6) (/tmp/herdr-agent-state.ts)\n")
            raise AssertionError(f"unexpected command: {args}")

        pane = {
            "agent": "pi",
            "pane_id": "pane:readonly",
            "workspace_id": "workspace:main",
            "cwd": str(repository),
        }
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "current_pane", return_value=pane),
            mock.patch.object(CREW.shutil, "which", side_effect=lambda name: f"/bin/{name}"),
        ):
            result = CREW.preflight(repository, read_only=True)
            committed = CREW.preflight(
                repository,
                read_only=True,
                committed_only=True,
                base="release",
            )

        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["branch"], "feature")
        self.assertTrue(result["dirty"])
        self.assertEqual(result["base_head"], "abc123")
        self.assertEqual(result["read_only_mode"], "isolated")
        self.assertTrue(committed["ok"], committed["errors"])
        self.assertEqual(committed["base_head"], "def456")

    def test_local_snapshot_materializes_tracked_and_nonignored_untracked_content(self) -> None:
        repository = self.create_repository("snapshot-repo")
        (repository / ".gitignore").write_text("cache/\n", encoding="utf-8")
        (repository / "tracked.txt").write_text("original\n", encoding="utf-8")
        (repository / "deleted.txt").write_text("delete me\n", encoding="utf-8")
        (repository / "binary.dat").write_bytes(b"original\x00data")
        script = repository / "script.sh"
        script.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.git(repository, "add", ".")
        self.git(repository, "commit", "-m", "test: initial")
        self.git(repository, "checkout", "-b", "feature")

        (repository / "tracked.txt").write_text("staged\n", encoding="utf-8")
        self.git(repository, "add", "tracked.txt")
        (repository / "tracked.txt").write_text("working\n", encoding="utf-8")
        (repository / "deleted.txt").unlink()
        (repository / "binary.dat").write_bytes(b"changed\x00binary")
        script.chmod(0o755)
        (repository / "untracked file.txt").write_text("local\n", encoding="utf-8")
        os.symlink("tracked.txt", repository / "untracked-link")
        (repository / "cache").mkdir()
        (repository / "cache" / "secret.txt").write_text("ignored\n", encoding="utf-8")

        patch, paths, export_before = CREW.local_export_state(repository)
        self.assertIn(Path("untracked file.txt"), paths)
        self.assertIn(Path("untracked-link"), paths)
        self.assertNotIn(Path("cache/secret.txt"), paths)

        worker = Path(self.temporary.name) / "snapshot-worker"
        self.git(repository, "worktree", "add", "-b", "snapshot-worker", str(worker), "HEAD")
        try:
            CREW.materialize_local_snapshot(repository, worker, patch, paths)
            _, _, export_after = CREW.local_export_state(repository)
            self.assertEqual(export_after, export_before)
            self.assertEqual((worker / "tracked.txt").read_text(encoding="utf-8"), "working\n")
            self.assertFalse((worker / "deleted.txt").exists())
            self.assertEqual((worker / "binary.dat").read_bytes(), b"changed\x00binary")
            self.assertTrue((worker / "script.sh").stat().st_mode & stat.S_IXUSR)
            self.assertEqual((worker / "untracked file.txt").read_text(encoding="utf-8"), "local\n")
            self.assertTrue((worker / "untracked-link").is_symlink())
            self.assertFalse((worker / "cache" / "secret.txt").exists())

            baseline = CREW.worktree_manifest(worker)
            (worker / "cache").mkdir()
            (worker / "cache" / "generated.txt").write_text("generated\n", encoding="utf-8")
            differences = CREW.manifest_differences(baseline, CREW.worktree_manifest(worker))
            self.assertIn("cache/generated.txt", differences)
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worker)],
                cwd=repository,
                capture_output=True,
                check=False,
            )
            subprocess.run(
                ["git", "branch", "-D", "snapshot-worker"],
                cwd=repository,
                capture_output=True,
                check=False,
            )

    def test_read_only_resource_cleanup_accepts_recorded_dirty_baseline(self) -> None:
        repository = self.create_repository("cleanup-repo")
        (repository / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        self.git(repository, "add", "tracked.txt")
        self.git(repository, "commit", "-m", "test: initial")
        branch = "dbz-crew/test/readonly"
        worker_path = CREW.worktree_path(repository, branch)
        worker_path.parent.mkdir(parents=True)
        self.git(repository, "worktree", "add", "-b", branch, str(worker_path), "HEAD")
        (worker_path / "local.txt").write_text("snapshot\n", encoding="utf-8")
        baseline = CREW.worktree_manifest(worker_path)
        worker = {
            "repo_root": str(repository),
            "branch": branch,
            "worktree": str(worker_path),
        }

        CREW.remove_isolated_read_only_resources(worker, baseline)

        self.assertFalse(worker_path.exists())
        result = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
            cwd=repository,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_in_place_dispatch_does_not_create_a_git_worktree(self) -> None:
        repository = self.create_repository("in-place-dispatch")
        (repository / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        self.git(repository, "add", "tracked.txt")
        self.git(repository, "commit", "-m", "test: initial")
        check = {
            "repo_root": str(repository),
            "main_pane": "pane:main",
            "main_workspace": "workspace:main",
            "principal_agent": "pi",
            "principal_session_id": "session-test",
            "worker_config": CREW.pi_worker_configuration(),
            "source_head": self.git(repository, "rev-parse", "HEAD"),
            "base_head": self.git(repository, "rev-parse", "HEAD"),
        }
        args = argparse.Namespace(
            task_id="inspect-live",
            prompt="Inspect without changes",
            base=None,
            read_only=True,
            in_place=True,
            committed_only=False,
            parallel=False,
            worker_provider=None,
            worker_model=None,
            worker_thinking=None,
        )
        calls: list[list[str]] = []
        original_command = CREW.command

        def fake_command(command_args: list[str], cwd: Path | None = None):
            calls.append(command_args)
            if command_args[0] == "git":
                return original_command(command_args, cwd)
            if command_args[:3] == ["herdr", "tab", "create"]:
                return completed(stdout='{"tab_id":"tab:worker","pane_id":"pane:worker"}\n')
            if command_args[:3] == ["herdr", "agent", "start"]:
                return completed()
            if command_args[:3] == ["herdr", "pane", "split"]:
                return completed(stdout='{"pane_id":"pane:monitor"}\n')
            raise AssertionError(f"unexpected command: {command_args}")

        with (
            mock.patch.object(CREW, "require_preflight", return_value=check),
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "launch_monitor") as launch_monitor,
            mock.patch("builtins.print"),
        ):
            CREW.dispatch(args)

        state = json.loads(CREW.state_path("pane:main").read_text(encoding="utf-8"))
        worker = state["workers"]["inspect-live"]
        self.assertIsNone(worker["branch"])
        self.assertEqual(worker["worktree"], str(repository))
        self.assertEqual(worker["read_only_mode"], "in-place")
        self.assertFalse(any(call[:3] == ["git", "worktree", "add"] for call in calls))
        launch_monitor.assert_called_once()

    def test_pi_monitor_writes_session_event_without_prompting_the_principal(self) -> None:
        pane = "pane:pi"
        CREW.write_json(
            CREW.state_path(pane),
            {"main_pane": pane, "queue": [], "workers": {"worker-one": {"status": "running"}}},
        )
        prompt = self.state_root / "prompt.txt"
        CREW.write_private_text(prompt, "Implement the task")
        calls: list[list[str]] = []

        def fake_command(args: list[str], cwd: Path | None = None):
            calls.append(args)
            if args[:4] == ["herdr", "agent", "prompt", "worker-agent"]:
                return completed(stdout='{"agent_status":"idle"}\n')
            if args[:4] == ["herdr", "agent", "read", "worker-agent"]:
                return completed(stdout="DBZ-CREW RESULT: done\n")
            if args[:3] == ["herdr", "notification", "show"]:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        args = argparse.Namespace(
            phase="implementation",
            prompt_file=str(prompt),
            worker="worker-agent",
            main_pane=pane,
            task_id="worker-one",
            principal_agent="pi",
            principal_session_id="session-test",
        )
        with mock.patch.object(CREW, "command", side_effect=fake_command):
            CREW.monitor(args)

        self.assertFalse(any(call[:4] == ["herdr", "agent", "prompt", pane] for call in calls))
        events = list(CREW.event_directory("session-test").glob("*.json"))
        self.assertEqual(len(events), 1)
        self.assertEqual(json.loads(events[0].read_text())["status"], "done")

    def test_isolated_read_only_monitor_fails_and_retains_changed_snapshot(self) -> None:
        pane = "pane:readonly-isolated"
        snapshot = CREW.snapshot_path(pane, "worker-one")
        baseline = {"head": "abc", "branch": "worker", "index_sha256": "index", "entries": []}
        CREW.write_json(snapshot, baseline)
        CREW.write_json(
            CREW.state_path(pane),
            {
                "main_pane": pane,
                "queue": [],
                "workers": {
                    "worker-one": {
                        "status": "running",
                        "read_only": True,
                        "read_only_mode": "isolated",
                        "snapshot": str(snapshot),
                        "worktree": "/fake/worktree",
                        "tab": "tab:worker",
                    }
                },
            },
        )
        prompt = self.state_root / "prompt-readonly.txt"
        CREW.write_private_text(prompt, "Inspect the repository")

        def fake_command(args: list[str], cwd: Path | None = None):
            if args[:4] == ["herdr", "agent", "prompt", "worker-agent"]:
                return completed(stdout='{"agent_status":"idle"}\n')
            if args[:4] == ["herdr", "agent", "read", "worker-agent"]:
                return completed(stdout="DBZ-CREW RESULT: inspected\n")
            if args[:3] == ["herdr", "notification", "show"]:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        final = {
            **baseline,
            "entries": [{"path": "changed.txt", "type": "file", "mode": 420, "size": 1, "sha256": "x"}],
        }
        args = argparse.Namespace(
            phase="implementation",
            prompt_file=str(prompt),
            worker="worker-agent",
            main_pane=pane,
            task_id="worker-one",
            principal_agent="pi",
            principal_session_id="session-test",
        )
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "worktree_manifest", return_value=final),
            mock.patch.object(CREW, "remove_isolated_read_only_resources") as remove_resources,
            mock.patch.object(CREW, "launch_read_only_finalizer") as launch_finalizer,
        ):
            CREW.monitor(args)

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertEqual(state["workers"]["worker-one"]["status"], "failed")
        output = CREW.result_path(pane, "worker-one").read_text(encoding="utf-8")
        self.assertIn("DBZ-CREW READ-ONLY VIOLATION", output)
        self.assertIn("changed.txt", output)
        remove_resources.assert_not_called()
        launch_finalizer.assert_not_called()

    def test_in_place_read_only_monitor_warns_without_failing_and_finalizes(self) -> None:
        pane = "pane:readonly-in-place"
        snapshot = CREW.snapshot_path(pane, "worker-one")
        baseline = {"head": "abc", "branch": "feature", "index_sha256": "index", "entries": []}
        CREW.write_json(snapshot, baseline)
        CREW.write_json(
            CREW.state_path(pane),
            {
                "main_pane": pane,
                "queue": [],
                "workers": {
                    "worker-one": {
                        "status": "running",
                        "read_only": True,
                        "read_only_mode": "in-place",
                        "snapshot": str(snapshot),
                        "worktree": "/fake/repository",
                        "tab": "tab:worker",
                    }
                },
            },
        )
        prompt = self.state_root / "prompt-in-place.txt"
        CREW.write_private_text(prompt, "Inspect the live repository")

        def fake_command(args: list[str], cwd: Path | None = None):
            if args[:4] == ["herdr", "agent", "prompt", "worker-agent"]:
                return completed(stdout='{"agent_status":"done"}\n')
            if args[:4] == ["herdr", "agent", "read", "worker-agent"]:
                return completed(stdout="DBZ-CREW RESULT: inspected\n")
            if args[:3] == ["herdr", "notification", "show"]:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        final = {
            **baseline,
            "entries": [{"path": "live.txt", "type": "file", "mode": 420, "size": 1, "sha256": "x"}],
        }
        args = argparse.Namespace(
            phase="implementation",
            prompt_file=str(prompt),
            worker="worker-agent",
            main_pane=pane,
            task_id="worker-one",
            principal_agent="pi",
            principal_session_id="session-test",
        )
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "worktree_manifest", return_value=final),
            mock.patch.object(CREW, "launch_read_only_finalizer") as launch_finalizer,
        ):
            CREW.monitor(args)

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertEqual(state["workers"]["worker-one"]["status"], "done")
        output = CREW.result_path(pane, "worker-one").read_text(encoding="utf-8")
        self.assertIn("DBZ-CREW READ-ONLY WARNING", output)
        self.assertIn("live.txt", output)
        launch_finalizer.assert_called_once_with(pane, "worker-one", "tab:worker")

    def test_unchanged_isolated_read_only_monitor_captures_result_then_cleans(self) -> None:
        pane = "pane:readonly-clean"
        snapshot = CREW.snapshot_path(pane, "worker-one")
        baseline = {"head": "abc", "branch": "worker", "index_sha256": "index", "entries": []}
        CREW.write_json(snapshot, baseline)
        CREW.write_json(
            CREW.state_path(pane),
            {
                "main_pane": pane,
                "queue": [],
                "workers": {
                    "worker-one": {
                        "status": "running",
                        "read_only": True,
                        "read_only_mode": "isolated",
                        "snapshot": str(snapshot),
                        "worktree": "/fake/worktree",
                        "tab": "tab:worker",
                    }
                },
            },
        )
        prompt = self.state_root / "prompt-clean.txt"
        CREW.write_private_text(prompt, "Inspect without changes")

        def fake_command(args: list[str], cwd: Path | None = None):
            if args[:4] == ["herdr", "agent", "prompt", "worker-agent"]:
                return completed(stdout='{"agent_status":"done"}\n')
            if args[:4] == ["herdr", "agent", "read", "worker-agent"]:
                return completed(stdout="DBZ-CREW RESULT: inspected\n")
            if args[:3] == ["herdr", "notification", "show"]:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        def remove_resources(worker: dict, captured: dict) -> None:
            self.assertEqual(captured, baseline)
            self.assertTrue(CREW.result_path(pane, "worker-one").is_file())

        args = argparse.Namespace(
            phase="implementation",
            prompt_file=str(prompt),
            worker="worker-agent",
            main_pane=pane,
            task_id="worker-one",
            principal_agent="pi",
            principal_session_id="session-test",
        )
        with (
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "worktree_manifest", return_value=baseline),
            mock.patch.object(CREW, "remove_isolated_read_only_resources", side_effect=remove_resources),
            mock.patch.object(CREW, "launch_read_only_finalizer") as launch_finalizer,
        ):
            CREW.monitor(args)

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertEqual(state["workers"]["worker-one"]["status"], "done")
        launch_finalizer.assert_called_once_with(pane, "worker-one", "tab:worker")

    def test_read_only_finalizer_closes_tab_and_removes_private_snapshot(self) -> None:
        pane = "pane:finalizer"
        snapshot = CREW.snapshot_path(pane, "worker-one")
        CREW.write_json(snapshot, {"head": "abc", "branch": "feature", "index_sha256": "index", "entries": []})
        CREW.write_json(
            CREW.state_path(pane),
            {
                "main_pane": pane,
                "queue": [],
                "workers": {
                    "worker-one": {
                        "read_only": True,
                        "tab": "tab:worker",
                        "snapshot": str(snapshot),
                    }
                },
            },
        )
        args = argparse.Namespace(main_pane=pane, task_id="worker-one", tab="tab:worker")
        with (
            mock.patch.object(CREW.time, "sleep"),
            mock.patch.object(CREW, "command", return_value=completed()) as invoked,
        ):
            CREW.finalize_read_only(args)

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertNotIn("worker-one", state["workers"])
        self.assertFalse(snapshot.exists())
        invoked.assert_called_once_with(["herdr", "tab", "close", "tab:worker"])

    def test_parallel_worker_records_merge_without_lost_updates(self) -> None:
        pane = "pane:parallel"

        def record(index: int) -> None:
            CREW.record_dispatched_worker(
                pane,
                f"worker-{index}",
                {"status": "running", "branch": f"branch-{index}"},
                True,
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(record, range(12)))

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertEqual(len(state["workers"]), 12)

    def test_concurrent_non_parallel_worker_is_rejected(self) -> None:
        pane = "pane:single"
        CREW.record_dispatched_worker(pane, "worker-one", {"status": "running"}, False)
        with self.assertRaisesRegex(CREW.CrewError, "became active"):
            CREW.record_dispatched_worker(pane, "worker-two", {"status": "running"}, False)

    def test_workflow_adapter_validates_and_reuses_the_exact_ticket_worktree(self) -> None:
        repository = self.create_repository("workflow-adapter-repo")
        (repository / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        self.git(repository, "add", "tracked.txt")
        self.git(repository, "commit", "-m", "test: initial")
        self.git(repository, "checkout", "-b", "dbz-workflows/WF-0001-example")
        branch = "dbz-tickets/WF-0001/T-0001-research"
        worktree = Path(self.temporary.name) / "ticket-worktree"
        self.git(repository, "worktree", "add", "-b", branch, str(worktree), "HEAD")

        resolved, actual_branch = CREW.validate_workflow_adapter_worktree(
            repository.resolve(),
            str(worktree.resolve()),
            branch,
        )
        self.assertEqual(resolved, worktree.resolve())
        self.assertEqual(actual_branch, branch)

        link = Path(self.temporary.name) / "ticket-link"
        link.symlink_to(worktree, target_is_directory=True)
        with self.assertRaisesRegex(CREW.CrewError, "real normalized directory"):
            CREW.validate_workflow_adapter_worktree(repository.resolve(), str(link), branch)

    def test_workflow_adapter_dispatch_uses_external_ticket_worktree_and_worker_guard(self) -> None:
        repository = self.create_repository("workflow-dispatch-repo")
        (repository / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        self.git(repository, "add", "tracked.txt")
        self.git(repository, "commit", "-m", "test: initial")
        self.git(repository, "checkout", "-b", "dbz-workflows/WF-0001-example")
        branch = "dbz-tickets/WF-0001/T-0001-implement"
        worktree = Path(self.temporary.name) / "workflow-ticket"
        self.git(repository, "worktree", "add", "-b", branch, str(worktree), "HEAD")
        check = {
            "repo_root": str(repository.resolve()),
            "main_pane": "pane:main",
            "main_workspace": "workspace:main",
            "principal_agent": "pi",
            "principal_session_id": "session-test",
            "worker_config": CREW.pi_worker_configuration(),
            "source_head": self.git(repository, "rev-parse", "HEAD"),
            "base_head": self.git(repository, "rev-parse", "HEAD"),
        }
        args = argparse.Namespace(
            task_id="dbzw-1234567890123456789",
            prompt="Execute the bounded workflow ticket",
            base=None,
            read_only=False,
            in_place=False,
            committed_only=False,
            parallel=False,
            workflow_adapter=True,
            existing_worktree=str(worktree.resolve()),
            expected_branch=branch,
            worker_provider=None,
            worker_model=None,
            worker_thinking=None,
        )
        calls: list[list[str]] = []
        original_command = CREW.command

        def fake_command(command_args: list[str], cwd: Path | None = None):
            calls.append(command_args)
            if command_args[0] == "git":
                return original_command(command_args, cwd)
            if command_args[:3] == ["herdr", "tab", "create"]:
                return completed(stdout='{"tab_id":"tab:worker","pane_id":"pane:worker"}\n')
            if command_args[:3] == ["herdr", "agent", "start"]:
                return completed()
            if command_args[:3] == ["herdr", "pane", "split"]:
                return completed(stdout='{"pane_id":"pane:monitor"}\n')
            raise AssertionError(f"unexpected command: {command_args}")

        with (
            mock.patch.object(CREW, "require_preflight", return_value=check),
            mock.patch.object(CREW, "command", side_effect=fake_command),
            mock.patch.object(CREW, "launch_monitor") as launch_monitor,
            mock.patch("builtins.print"),
        ):
            CREW.dispatch(args)

        state = json.loads(CREW.state_path("pane:main").read_text(encoding="utf-8"))
        worker = state["workers"][args.task_id]
        self.assertEqual(worker["branch"], branch)
        self.assertEqual(worker["worktree"], str(worktree.resolve()))
        self.assertTrue(worker["workflow_adapter"])
        self.assertFalse(worker["worktree_managed"])
        self.assertFalse(any(call[:3] == ["git", "worktree", "add"] for call in calls))
        tab_call = next(call for call in calls if call[:3] == ["herdr", "tab", "create"])
        self.assertIn(f"{CREW.WORKFLOW_ADAPTER_ENV}={CREW.WORKFLOW_ADAPTER_VALUE}", tab_call)
        start_call = next(call for call in calls if call[:3] == ["herdr", "agent", "start"])
        self.assertIn("--no-skills", start_call)
        prompt = CREW.read_private_text(CREW.task_path("pane:main", args.task_id))
        self.assertIn("do not edit canonical DBZ Workflows artifacts", prompt)
        launch_monitor.assert_called_once()

    def test_workflow_adapter_cancel_and_release_preserve_owned_worktrees(self) -> None:
        pane = "pane:workflow-control"
        active_task = "dbzw-1234567890123456789"
        done_task = "dbzw-abcdefabcdefabcdefa"
        worktree = str(Path(self.temporary.name) / "preserved-ticket-worktree")
        CREW.write_json(
            CREW.state_path(pane),
            {
                "main_pane": pane,
                "queue": [],
                "workers": {
                    active_task: {
                        "status": "running",
                        "tab": "tab:active",
                        "principal_session_id": "session-test",
                        "workflow_adapter": True,
                        "worktree_managed": False,
                        "worktree": worktree,
                        "branch": "dbz-tickets/WF-0001/T-0001-active",
                    },
                    done_task: {
                        "status": "done",
                        "tab": "tab:done",
                        "workflow_adapter": True,
                        "worktree_managed": False,
                        "worktree": worktree,
                        "branch": "dbz-tickets/WF-0001/T-0002-done",
                    },
                },
            },
        )
        pane_value = {"pane_id": pane}
        with (
            mock.patch.object(CREW, "current_pane", return_value=pane_value),
            mock.patch.object(CREW, "command", return_value=completed()) as invoked,
            mock.patch("builtins.print"),
        ):
            CREW.cancel(argparse.Namespace(task_id=active_task, reason="Coordinator cancelled the wave"))
            CREW.release(argparse.Namespace(task_id=done_task))

        state = json.loads(CREW.state_path(pane).read_text(encoding="utf-8"))
        self.assertEqual(state["workers"][active_task]["status"], "failed")
        self.assertNotIn(done_task, state["workers"])
        self.assertEqual(
            CREW.result_path(pane, active_task).read_text(encoding="utf-8").splitlines()[0],
            "DBZ-CREW RESULT: failed",
        )
        self.assertEqual(
            [call.args[0] for call in invoked.call_args_list],
            [["herdr", "tab", "close", "tab:active"], ["herdr", "tab", "close", "tab:done"]],
        )
        self.assertFalse(Path(worktree).exists())
        events = list(CREW.event_directory("session-test").glob("*.json"))
        self.assertEqual(len(events), 1)
        event = json.loads(events[0].read_text(encoding="utf-8"))
        self.assertEqual(event["status"], "failed")
        self.assertIn("coordinator adapter will normalize", event["message"])
        self.assertIn("do not use DBZ Crew rebase, integrate, or cleanup", event["message"])

    def test_completion_updates_are_locked_and_event_files_are_private(self) -> None:
        pane = "pane:main"
        state_file = CREW.state_path(pane)
        CREW.write_json(
            state_file,
            {"main_pane": pane, "queue": [], "workers": {"worker-one": {"status": "running"}}},
        )
        result_file = CREW.result_path(pane, "worker-one")
        CREW.write_private_text(result_file, "DBZ-CREW RESULT: done\n")

        def append(index: int) -> None:
            CREW.append_event(
                pane,
                f"event-{index}",
                "worker-one",
                "implementation",
                "done",
                result_file,
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(append, range(12)))

        state = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(len(state["queue"]), 12)
        event_file = CREW.write_completion_event(
            "event-private",
            "session-test",
            "worker-one",
            "implementation",
            "done",
            result_file,
        )
        self.assertEqual(stat.S_IMODE(event_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(event_file.parent.stat().st_mode), 0o700)


if __name__ == "__main__":
    unittest.main()
