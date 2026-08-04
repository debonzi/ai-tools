from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "configure.py"
PACKAGE_ROOT = Path(__file__).resolve().parents[3]
CANONICAL_SOURCE = "npm:@debonzi/dbz-ai-tools"


class ConfigureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.project = self.root / "project"
        self.project.mkdir()
        self.env = dict(os.environ)
        self.env["HOME"] = str(self.home)
        self.env.pop("PI_CODING_AGENT_DIR", None)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @property
    def global_settings(self) -> Path:
        return self.home / ".pi" / "agent" / "settings.json"

    @property
    def project_settings(self) -> Path:
        return self.project / ".pi" / "settings.json"

    def write_json(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def run_helper(self, *arguments: str, expected: int = 0) -> dict[str, object]:
        result = subprocess.run(
            ["python3", str(SCRIPT), *arguments],
            cwd=self.project,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, expected, result.stderr or result.stdout)
        stream = result.stdout if expected == 0 else result.stderr
        return json.loads(stream)

    def test_catalog_discovers_package_resources(self) -> None:
        result = self.run_helper("list")
        self.assertEqual(
            [entry["name"] for entry in result["skills"]],
            ["dbz-ai-tools-setup", "dbz-crew", "dbz-issues", "dbz-spec", "dbz-workflows"],
        )
        self.assertEqual(
            [entry["name"] for entry in result["extensions"]],
            ["codex-usage", "dbz-crew-events"],
        )

    def test_global_allowlist_preserves_unrelated_settings_and_is_idempotent(self) -> None:
        original = {
            "theme": "dark",
            "packages": [CANONICAL_SOURCE, "npm:unrelated-package"],
            "customSetting": {"preserve": True},
        }
        self.write_json(self.global_settings, original)
        plan = self.run_helper(
            "plan",
            "--scope",
            "global",
            "--skill",
            "dbz-crew",
            "--enable-codex-usage",
        )
        package = plan["package_after"]
        self.assertEqual(
            package["skills"],
            [
                "skills/dbz-ai-tools-setup/SKILL.md",
                "skills/dbz-crew/SKILL.md",
            ],
        )
        self.assertEqual(
            package["extensions"],
            [
                "agents/pi/extensions/codex-usage/index.ts",
                "agents/pi/extensions/dbz-crew-events/index.ts",
            ],
        )
        self.assertNotIn("autoload", package)

        self.run_helper(
            "apply",
            "--scope",
            "global",
            "--skill",
            "dbz-crew",
            "--enable-codex-usage",
            "--expected-sha256",
            str(plan["before_sha256"]),
        )
        updated = json.loads(self.global_settings.read_text(encoding="utf-8"))
        self.assertEqual(updated["theme"], "dark")
        self.assertEqual(updated["customSetting"], {"preserve": True})
        self.assertEqual(updated["packages"][1], "npm:unrelated-package")
        second = self.run_helper(
            "plan",
            "--scope",
            "global",
            "--skill",
            "dbz-crew",
            "--enable-codex-usage",
        )
        self.assertFalse(second["changed"])

    def test_official_npm_source_forms_match_the_package(self) -> None:
        sources = [
            "npm:@debonzi/dbz-ai-tools",
            "npm:@debonzi/dbz-ai-tools@0.1.0",
            "npm:@debonzi/dbz-ai-tools@latest",
        ]
        for source in sources:
            with self.subTest(source=source):
                self.write_json(self.global_settings, {"packages": [source]})
                plan = self.run_helper("plan", "--scope", "global", "--skill", "dbz-spec")
                self.assertEqual(plan["package_after"]["source"], source)

    def test_official_git_source_forms_remain_supported(self) -> None:
        sources = [
            "https://github.com/debonzi/dbz-ai-tools",
            "git:https://github.com/debonzi/dbz-ai-tools.git@main",
            "git:git@github.com:debonzi/dbz-ai-tools",
            "ssh://git@github.com/debonzi/dbz-ai-tools@main",
        ]
        for source in sources:
            with self.subTest(source=source):
                self.write_json(self.global_settings, {"packages": [source]})
                plan = self.run_helper("plan", "--scope", "global", "--skill", "dbz-spec")
                self.assertEqual(plan["package_after"]["source"], source)

    def test_project_override_disables_all_then_enables_selected_resources(self) -> None:
        self.write_json(self.global_settings, {"packages": [CANONICAL_SOURCE]})
        self.write_json(self.project_settings, {"theme": "light", "packages": ["npm:project-tool"]})
        plan = self.run_helper(
            "plan",
            "--scope",
            "project",
            "--project-root",
            str(self.project),
            "--skill",
            "dbz-spec",
        )
        package = plan["package_after"]
        self.assertEqual(plan["mode"], "delta")
        self.assertFalse(package["autoload"])
        self.assertEqual(
            package["skills"],
            [
                "!skills/**",
                "+skills/dbz-ai-tools-setup/SKILL.md",
                "+skills/dbz-spec/SKILL.md",
            ],
        )
        self.assertEqual(package["extensions"], ["!agents/pi/extensions/**"])

        self.run_helper(
            "apply",
            "--scope",
            "project",
            "--project-root",
            str(self.project),
            "--skill",
            "dbz-spec",
            "--expected-sha256",
            str(plan["before_sha256"]),
        )
        updated = json.loads(self.project_settings.read_text(encoding="utf-8"))
        self.assertEqual(updated["theme"], "light")
        self.assertEqual(updated["packages"][0], "npm:project-tool")
        self.assertEqual(updated["packages"][1]["source"], CANONICAL_SOURCE)

    def test_project_local_package_uses_a_full_allowlist(self) -> None:
        self.write_json(self.project_settings, {"packages": [str(PACKAGE_ROOT)]})
        plan = self.run_helper(
            "plan",
            "--scope",
            "project",
            "--project-root",
            str(self.project),
            "--skill",
            "dbz-issues",
        )
        package = plan["package_after"]
        self.assertEqual(plan["mode"], "full")
        self.assertNotIn("autoload", package)
        self.assertEqual(
            package["skills"],
            [
                "skills/dbz-ai-tools-setup/SKILL.md",
                "skills/dbz-issues/SKILL.md",
            ],
        )

    def test_stale_plan_is_rejected_without_replacement(self) -> None:
        self.write_json(self.global_settings, {"packages": [CANONICAL_SOURCE]})
        plan = self.run_helper("plan", "--scope", "global", "--skill", "dbz-spec")
        changed = {"packages": [CANONICAL_SOURCE], "theme": "light"}
        self.write_json(self.global_settings, changed)
        result = self.run_helper(
            "apply",
            "--scope",
            "global",
            "--skill",
            "dbz-spec",
            "--expected-sha256",
            str(plan["before_sha256"]),
            expected=1,
        )
        self.assertIn("stale", result["message"])
        self.assertEqual(json.loads(self.global_settings.read_text(encoding="utf-8")), changed)

    def test_symlinked_settings_file_is_rejected(self) -> None:
        target = self.root / "unexpected.json"
        self.write_json(target, {"packages": [CANONICAL_SOURCE]})
        self.global_settings.parent.mkdir(parents=True)
        self.global_settings.symlink_to(target)
        result = self.run_helper("plan", "--scope", "global", expected=1)
        self.assertIn("symbolic link", result["message"])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"packages": [CANONICAL_SOURCE]})

    def test_symlinked_settings_directory_is_rejected(self) -> None:
        unexpected = self.root / "unexpected-agent"
        unexpected.mkdir()
        pi_directory = self.home / ".pi"
        pi_directory.mkdir()
        (pi_directory / "agent").symlink_to(unexpected, target_is_directory=True)
        result = self.run_helper("plan", "--scope", "global", expected=1)
        self.assertIn("symbolic link", result["message"])
        self.assertEqual(list(unexpected.iterdir()), [])

    def test_unknown_skill_is_rejected(self) -> None:
        self.write_json(self.global_settings, {"packages": [CANONICAL_SOURCE]})
        result = self.run_helper(
            "plan",
            "--scope",
            "global",
            "--skill",
            "not-a-skill",
            expected=1,
        )
        self.assertIn("unknown skill", result["message"])


if __name__ == "__main__":
    unittest.main()
