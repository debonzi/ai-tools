from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackageManifestTests(unittest.TestCase):
    def test_manifest_exposes_only_intended_pi_resources(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertTrue(package["private"])
        self.assertIn("pi-package", package["keywords"])
        self.assertNotIn("scripts", package)
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

        self.assertEqual(names, {"dbz-ai-tools-setup", "dbz-crew", "dbz-issues", "dbz-spec"})

    def test_setup_is_explicit_and_dbz_crew_bundles_its_cli(self) -> None:
        setup = (ROOT / "skills/dbz-ai-tools-setup/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("disable-model-invocation: true", setup)
        cli = ROOT / "skills/dbz-crew/scripts/dbz-crew"
        self.assertTrue(cli.is_file())
        self.assertTrue(cli.stat().st_mode & 0o100)
        self.assertFalse((ROOT / "tools/dbz-crew").exists())


if __name__ == "__main__":
    unittest.main()
