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


SCRIPT = Path(__file__).resolve().parents[1] / "dbz-crew"
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
        self.state_root = Path(self.temporary.name) / "state"
        self.environment = mock.patch.dict(
            os.environ,
            {
                "DBZ_CREW_STATE_DIR": str(self.state_root),
                "PI_PROVIDER": "openai-codex",
                "PI_MODEL": "gpt-test",
                "PI_REASONING_LEVEL": "high",
                "PI_SESSION_ID": "session-test",
            },
            clear=False,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

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
            CREW.worker_start_command("crew-test", "pi", "pane:2", config),
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
        self.assertNotIn("--provider", CREW.worker_start_command("crew-test", "codex", "pane:2", None))

    def test_idle_worker_state_is_normalized_to_done(self) -> None:
        self.assertEqual(CREW.event_status('{"result":{"agent_status":"idle"}}'), "done")
        self.assertEqual(CREW.event_status('{"result":{"agent_status":"blocked"}}'), "blocked")

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
                return completed(stdout="possible values: pi, codex\n")
            if key == ("herdr", "integration", "status"):
                return completed(stdout="pi: installed (version 6)\n")
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

    def test_codex_preflight_does_not_require_pi_runtime_metadata(self) -> None:
        repository = Path(self.temporary.name) / "codex-repo"
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
            "pane_id": "pane:codex",
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
        self.assertEqual(result["principal_agent"], "codex")
        self.assertIsNone(result["worker_config"])

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

    def test_codex_monitor_waits_for_principal_before_delivery(self) -> None:
        pane = "pane:codex"
        CREW.write_json(
            CREW.state_path(pane),
            {"main_pane": pane, "queue": [], "workers": {"worker-one": {"status": "running"}}},
        )
        prompt = self.state_root / "prompt-codex.txt"
        CREW.write_private_text(prompt, "Implement the task")
        calls: list[list[str]] = []

        def fake_command(args: list[str], cwd: Path | None = None):
            calls.append(args)
            if args[:4] == ["herdr", "agent", "prompt", "worker-agent"]:
                return completed(stdout='{"agent_status":"done"}\n')
            if args[:4] == ["herdr", "agent", "read", "worker-agent"]:
                return completed(stdout="DBZ-CREW RESULT: done\n")
            if args[:3] == ["herdr", "notification", "show"]:
                return completed()
            if args[:4] == ["herdr", "agent", "wait", pane]:
                return completed(stdout='{"agent_status":"idle"}\n')
            if args[:4] == ["herdr", "agent", "prompt", pane]:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        args = argparse.Namespace(
            phase="implementation",
            prompt_file=str(prompt),
            worker="worker-agent",
            main_pane=pane,
            task_id="worker-one",
            principal_agent="codex",
            principal_session_id=None,
        )
        with mock.patch.object(CREW, "command", side_effect=fake_command):
            CREW.monitor(args)

        wait_index = next(i for i, call in enumerate(calls) if call[:4] == ["herdr", "agent", "wait", pane])
        prompt_index = next(i for i, call in enumerate(calls) if call[:4] == ["herdr", "agent", "prompt", pane])
        self.assertLess(wait_index, prompt_index)

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
