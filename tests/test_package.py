from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackageManifestTests(unittest.TestCase):
    def test_manifest_exposes_only_intended_pi_resources(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["name"], "@debonzi/dbz-ai-tools")
        self.assertEqual(package["version"], "0.1.0")
        self.assertNotIn("private", package)
        self.assertIn("pi-package", package["keywords"])
        self.assertEqual(package["publishConfig"], {"access": "public"})
        self.assertEqual(
            package["repository"],
            {
                "type": "git",
                "url": "git+https://github.com/debonzi/dbz-ai-tools.git",
            },
        )
        self.assertEqual(package["pi"]["skills"], ["./skills"])
        self.assertEqual(
            package["pi"]["extensions"],
            [
                "./agents/pi/extensions/codex-usage/index.ts",
                "./agents/pi/extensions/dbz-crew-events/index.ts",
            ],
        )
        for resource in package["pi"]["extensions"]:
            self.assertTrue((ROOT / resource).is_file(), resource)

    def test_packed_archive_contains_only_runtime_context(self) -> None:
        result = subprocess.run(
            ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        payload = json.loads(result.stdout)
        if isinstance(payload, list):
            details = payload[0]
        elif "files" in payload:
            details = payload
        else:
            details = next(iter(payload.values()))
        packed = {entry["path"]: entry for entry in details["files"]}
        expected = {
            "CHANGELOG.md",
            "LICENSE",
            "README.md",
            "agents/pi/extensions/codex-usage/README.md",
            "agents/pi/extensions/codex-usage/config.example.json",
            "agents/pi/extensions/codex-usage/core.ts",
            "agents/pi/extensions/codex-usage/index.ts",
            "agents/pi/extensions/dbz-crew-events/README.md",
            "agents/pi/extensions/dbz-crew-events/index.ts",
            "package.json",
            "skills/dbz-ai-tools-setup/SKILL.md",
            "skills/dbz-ai-tools-setup/scripts/configure.py",
            "skills/dbz-crew/SKILL.md",
            "skills/dbz-crew/references/CLI.md",
            "skills/dbz-crew/scripts/dbz-crew",
            "skills/dbz-issues/SKILL.md",
            "skills/dbz-issues/scripts/issues.py",
            "skills/dbz-spec/SKILL.md",
            "skills/dbz-spec/agents/openai.yaml",
        }
        self.assertEqual(set(packed), expected)
        for script in (
            "skills/dbz-ai-tools-setup/scripts/configure.py",
            "skills/dbz-crew/scripts/dbz-crew",
            "skills/dbz-issues/scripts/issues.py",
        ):
            self.assertTrue(packed[script]["mode"] & 0o100, script)

    def test_every_skill_has_matching_valid_name_and_description(self) -> None:
        names: set[str] = set()
        for skill_file in sorted((ROOT / "skills").rglob("SKILL.md")):
            text = skill_file.read_text(encoding="utf-8")
            match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
            self.assertIsNotNone(match, skill_file)
            frontmatter = match.group(1)
            name_match = re.search(r"^name:\s*(\S+)\s*$", frontmatter, re.MULTILINE)
            description_match = re.search(r"^description:\s*(.+)$", frontmatter, re.MULTILINE)
            self.assertIsNotNone(name_match, skill_file)
            self.assertIsNotNone(description_match, skill_file)
            name = name_match.group(1)
            self.assertEqual(name, skill_file.parent.name)
            self.assertRegex(name, r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
            self.assertLessEqual(len(name), 64)
            self.assertLessEqual(len(description_match.group(1)), 1024)
            self.assertNotIn(name, names)
            names.add(name)

        self.assertEqual(
            names,
            {"dbz-ai-tools-setup", "dbz-crew", "dbz-issues", "dbz-spec", "dbz-workflows"},
        )

    def test_setup_is_explicit_and_dbz_crew_bundles_its_cli(self) -> None:
        setup = (ROOT / "skills/dbz-ai-tools-setup/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("disable-model-invocation: true", setup)
        cli = ROOT / "skills/dbz-crew/scripts/dbz-crew"
        self.assertTrue(cli.is_file())
        self.assertTrue(cli.stat().st_mode & 0o100)
        self.assertFalse((ROOT / "tools/dbz-crew").exists())


if __name__ == "__main__":
    unittest.main()
