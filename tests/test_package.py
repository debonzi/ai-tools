from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "packages"
EXPECTED_WORKSPACES = {
    "dbz-skills": "@debonzi/dbz-skills",
    "dbz-crew": "@debonzi/dbz-crew",
    "pi-codex-usage": "@debonzi/pi-codex-usage",
}
EXPECTED_FILES = {
    "dbz-skills": {
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "skills/dbz-issues/SKILL.md",
        "skills/dbz-issues/scripts/issues.py",
        "skills/dbz-spec/SKILL.md",
        "skills/dbz-spec/agents/openai.yaml",
    },
    "dbz-crew": {
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "skills/dbz-crew/SKILL.md",
        "skills/dbz-crew/references/CLI.md",
        "skills/dbz-crew/scripts/dbz-crew",
        "skills/dbz-crew-setup/SKILL.md",
        "agents/pi/extensions/dbz-crew-events/README.md",
        "agents/pi/extensions/dbz-crew-events/index.ts",
    },
    "pi-codex-usage": {
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "agents/pi/extensions/codex-usage/README.md",
        "agents/pi/extensions/codex-usage/config.example.json",
        "agents/pi/extensions/codex-usage/core.ts",
        "agents/pi/extensions/codex-usage/index.ts",
    },
}
MUTATING_LIFECYCLE_SCRIPTS = {
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
}


def load_manifest(path: Path) -> dict:
    return json.loads((path / "package.json").read_text(encoding="utf-8"))


class PackageManifestTests(unittest.TestCase):
    def test_root_is_a_private_workspace_coordinator(self) -> None:
        package = load_manifest(ROOT)
        self.assertEqual(package["name"], "dbz-ai-tools-workspace")
        self.assertTrue(package["private"])
        self.assertEqual(package["type"], "module")
        self.assertEqual(package["workspaces"], ["packages/*"])
        self.assertNotIn("version", package)
        self.assertNotIn("pi", package)
        self.assertNotIn("dependencies", package)
        self.assertNotIn("peerDependencies", package)
        self.assertEqual(
            {path.name for path in PACKAGES.iterdir() if (path / "package.json").is_file()},
            set(EXPECTED_WORKSPACES),
        )

    def test_publishable_manifests_have_exact_resource_boundaries(self) -> None:
        expected_pi = {
            "dbz-skills": {"skills": ["./skills"]},
            "dbz-crew": {
                "skills": ["./skills"],
                "extensions": ["./agents/pi/extensions/dbz-crew-events/index.ts"],
            },
            "pi-codex-usage": {
                "extensions": ["./agents/pi/extensions/codex-usage/index.ts"],
            },
        }
        expected_peers = {
            "dbz-skills": {},
            "dbz-crew": {"@earendil-works/pi-coding-agent": "*"},
            "pi-codex-usage": {
                "@earendil-works/pi-coding-agent": "*",
                "@earendil-works/pi-tui": "*",
            },
        }

        for directory, name in EXPECTED_WORKSPACES.items():
            with self.subTest(package=name):
                package_root = PACKAGES / directory
                package = load_manifest(package_root)
                self.assertEqual(package["name"], name)
                self.assertEqual(package["version"], "0.1.0")
                self.assertNotIn("private", package)
                self.assertIn("pi-package", package["keywords"])
                self.assertEqual(package["publishConfig"], {"access": "public"})
                self.assertEqual(
                    package["repository"],
                    {
                        "type": "git",
                        "url": "git+https://github.com/debonzi/dbz-ai-tools.git",
                        "directory": f"packages/{directory}",
                    },
                )
                self.assertEqual(package["pi"], expected_pi[directory])
                self.assertEqual(package.get("peerDependencies", {}), expected_peers[directory])
                self.assertEqual(set(package["files"]), EXPECTED_FILES[directory])
                self.assertTrue(MUTATING_LIFECYCLE_SCRIPTS.isdisjoint(package.get("scripts", {})))
                for relative in package["files"]:
                    self.assertTrue((package_root / relative).is_file(), f"{name}: {relative}")
                for resource_type in ("skills", "extensions"):
                    for relative in package["pi"].get(resource_type, []):
                        resource = (package_root / relative).resolve()
                        self.assertTrue(resource.is_relative_to(package_root.resolve()))
                        self.assertTrue(resource.exists(), f"{name}: {relative}")

    def test_every_workspace_skill_has_valid_unique_frontmatter(self) -> None:
        names: set[str] = set()
        for skill_file in sorted(PACKAGES.rglob("SKILL.md")):
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

        self.assertEqual(names, {"dbz-crew", "dbz-crew-setup", "dbz-issues", "dbz-spec"})

    def test_setup_is_explicit_scoped_and_confirmation_gated(self) -> None:
        setup = (PACKAGES / "dbz-crew/skills/dbz-crew-setup/SKILL.md").read_text(
            encoding="utf-8"
        )
        for requirement in (
            "disable-model-invocation: true",
            "command -v pi",
            "command -v python3",
            "command -v git",
            "command -v herdr",
            "herdr agent start --help",
            "herdr integration install --help",
            "herdr integration status",
            "herdr integration install pi",
            "explicit confirmation",
            "/reload",
        ):
            self.assertIn(requirement, setup)
        self.assertNotIn("@debonzi/dbz-ai-tools", setup)
        self.assertNotIn("configure.py", setup)
        self.assertFalse((ROOT / "skills/dbz-ai-tools-setup/SKILL.md").exists())
        self.assertFalse((ROOT / "skills/dbz-ai-tools-setup/scripts/configure.py").exists())

    def test_bundled_python_entry_points_remain_executable(self) -> None:
        for path in (
            PACKAGES / "dbz-skills/skills/dbz-issues/scripts/issues.py",
            PACKAGES / "dbz-crew/skills/dbz-crew/scripts/dbz-crew",
        ):
            self.assertTrue(path.is_file(), path)
            self.assertTrue(path.stat().st_mode & 0o100, path)


if __name__ == "__main__":
    unittest.main()
