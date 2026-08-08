from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SKILL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
SCRIPT = SKILL_ROOT / "scripts" / "issues.py"
SPEC = importlib.util.spec_from_file_location("dbz_issues_cli", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ISSUES = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ISSUES
SPEC.loader.exec_module(ISSUES)


class DbzIssuesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="dbz-issues-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "issues"

    def run_cli(
        self,
        *arguments: str,
        root: Path | None = None,
        cwd: Path | None = None,
        expected: int = 0,
    ) -> dict:
        command = [sys.executable, str(SCRIPT)]
        if root is not None:
            command.extend(["--root", str(root)])
        command.extend(arguments)
        result = subprocess.run(
            command,
            cwd=cwd or REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, expected, result.stderr or result.stdout)
        payload = json.loads(result.stdout if expected == 0 else result.stderr)
        self.assertEqual(payload["ok"], expected == 0)
        return payload

    def initialize(self) -> None:
        self.run_cli("init", root=self.root)

    def create(
        self,
        title: str,
        description: str = "Description",
        dependencies: list[str] | None = None,
    ) -> dict:
        arguments = ["create", "--title", title, "--description", description]
        if dependencies is not None:
            arguments.extend(["--depends-on", *dependencies])
        return self.run_cli(*arguments, root=self.root)["issue"]

    def test_init_is_explicit_idempotent_and_does_not_create_closed(self) -> None:
        first = self.run_cli("init", root=self.root)
        second = self.run_cli("init", root=self.root)
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertTrue((self.root / "open").is_dir())
        self.assertFalse((self.root / "closed").exists())

    def test_default_root_uses_git_toplevel(self) -> None:
        repository = Path(self.temporary.name) / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", repository], check=True)
        nested = repository / "nested"
        nested.mkdir()
        payload = self.run_cli("init", cwd=nested)
        self.assertEqual(Path(payload["root"]), repository / "issues")
        self.assertTrue((repository / "issues" / "open").is_dir())

    def test_init_rejects_file_and_symlink_destinations(self) -> None:
        file_root = Path(self.temporary.name) / "file-root"
        file_root.write_text("not a directory\n", encoding="utf-8")
        file_error = self.run_cli("init", root=file_root, expected=1)
        self.assertEqual(file_error["error"]["code"], "unsafe_path")

        actual = Path(self.temporary.name) / "actual"
        actual.mkdir()
        link = Path(self.temporary.name) / "linked-issues"
        link.symlink_to(actual, target_is_directory=True)
        link_error = self.run_cli("init", root=link, expected=1)
        self.assertEqual(link_error["error"]["code"], "unsafe_path")
        self.assertEqual(list(actual.iterdir()), [])

    def test_existing_registry_is_compatible_and_ready_is_dependency_aware(self) -> None:
        issues = ISSUES.load_registry(REPOSITORY_ROOT / "issues")
        self.assertEqual(len(issues), 12)
        self.assertEqual(
            [issue.number for issue in ISSUES.ready_issues(issues)],
            [2, 3, 6, 10, 11, 12],
        )

    def test_create_uses_sequential_ids_and_preserves_quoted_title(self) -> None:
        self.initialize()
        first = self.create('Quoted "café" title', "First description")
        second = self.create("Dependent title", dependencies=[first["id"]])
        self.assertEqual(first["id"], "001-quoted-cafe-title")
        self.assertEqual(first["title"], 'Quoted "café" title')
        self.assertEqual(second["id"], "002-dependent-title")
        parsed = self.run_cli("show", "001", root=self.root)["issue"]
        self.assertEqual(parsed["title"], first["title"])

    def test_concurrent_creation_reserves_unique_numbers(self) -> None:
        self.initialize()
        processes = [
            subprocess.Popen(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(self.root),
                    "create",
                    "--title",
                    f"Concurrent issue {index}",
                    "--description",
                    "Created concurrently",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for index in range(8)
        ]
        payloads = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, stderr)
            payloads.append(json.loads(stdout))
        numbers = sorted(int(payload["issue"]["number"]) for payload in payloads)
        self.assertEqual(numbers, list(range(1, 9)))
        self.assertEqual(len(list((self.root / "open").glob("*.md"))), 8)
        self.assertEqual(list((self.root / "open").glob(".*.dbz-issues-reservation")), [])

    def test_missing_duplicate_self_and_cyclic_dependencies_fail(self) -> None:
        self.initialize()
        missing = self.run_cli(
            "create",
            "--title",
            "Missing dependency",
            "--description",
            "Description",
            "--depends-on",
            "999-missing",
            root=self.root,
            expected=1,
        )
        self.assertEqual(missing["error"]["code"], "missing_dependency")

        first = self.create("First")
        duplicate = self.run_cli(
            "create",
            "--title",
            "Duplicate",
            "--description",
            "Description",
            "--depends-on",
            first["id"],
            first["id"],
            root=self.root,
            expected=1,
        )
        self.assertEqual(duplicate["error"]["code"], "duplicate_dependency")

        second = self.create("Second", dependencies=[first["id"]])
        self_dependency = self.run_cli(
            "edit",
            first["id"],
            "--depends-on",
            first["id"],
            root=self.root,
            expected=1,
        )
        self.assertEqual(self_dependency["error"]["code"], "self_dependency")
        cycle = self.run_cli(
            "edit",
            first["id"],
            "--depends-on",
            second["id"],
            root=self.root,
            expected=1,
        )
        self.assertEqual(cycle["error"]["code"], "dependency_cycle")

    def test_edit_preserves_filename_and_can_clear_dependencies(self) -> None:
        self.initialize()
        first = self.create("First")
        second = self.create("Second", dependencies=[first["id"]])
        original_path = second["path"]
        edited = self.run_cli(
            "edit",
            second["id"],
            "--title",
            "Renamed title",
            "--description",
            "Updated description",
            "--depends-on",
            root=self.root,
        )["issue"]
        self.assertEqual(edited["path"], original_path)
        self.assertEqual(edited["dependencies"], [])
        self.assertEqual(edited["title"], "Renamed title")

    def test_close_requires_closed_dependencies_and_closed_issues_are_immutable(self) -> None:
        self.initialize()
        prerequisite = self.create("Prerequisite")
        dependent = self.create("Dependent", dependencies=[prerequisite["id"]])
        blocked = self.run_cli("close", dependent["id"], root=self.root, expected=1)
        self.assertEqual(blocked["error"]["code"], "open_dependencies")
        self.assertFalse((self.root / "closed").exists())

        closed_prerequisite = self.run_cli("close", prerequisite["id"], root=self.root)["issue"]
        self.assertEqual(closed_prerequisite["status"], "closed")
        self.assertRegex(closed_prerequisite["closed"], r"^\d{4}-\d{2}-\d{2}$")
        ready = self.run_cli("ready", root=self.root)["issues"]
        self.assertEqual([issue["id"] for issue in ready], [dependent["id"]])
        immutable = self.run_cli(
            "edit",
            prerequisite["id"],
            "--title",
            "Changed",
            root=self.root,
            expected=1,
        )
        self.assertEqual(immutable["error"]["code"], "closed_issue_immutable")
        self.run_cli("close", dependent["id"], root=self.root)
        self.assertEqual(len(list((self.root / "closed").glob("*.md"))), 2)
        self.assertEqual(len(list((self.root / "open").glob("*.md"))), 0)

    def test_malformed_issue_returns_structured_json_error(self) -> None:
        self.initialize()
        malformed = self.root / "open" / "001-malformed.md"
        malformed.write_text("not frontmatter\n", encoding="utf-8")
        payload = self.run_cli("list", root=self.root, expected=1)
        self.assertEqual(payload["error"]["code"], "invalid_issue")

    def test_custom_root_can_be_copied_without_machine_state(self) -> None:
        self.initialize()
        self.create("Portable issue")
        copy = Path(self.temporary.name) / "copy"
        shutil.copytree(self.root, copy)
        payload = self.run_cli("list", root=copy)
        self.assertEqual(payload["issues"][0]["id"], "001-portable-issue")


if __name__ == "__main__":
    unittest.main()
