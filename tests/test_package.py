from __future__ import annotations

import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "packages"
EXPECTED_WORKSPACES = {
    "db11-skills": {
        "name": "@debonzi/db11-skills",
        "pi": {"skills": ["./skills"]},
        "peers": {},
        "files": {
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills/db11-plan/SKILL.md",
            "skills/db11-plan/agents/openai.yaml",
            "skills/db11-plan/assets/ticket-body.md",
            "skills/db11-plan/assets/topic-task-body.md",
            "skills/db11-plan/references/protocol.md",
            "skills/db11-plan/references/wyrd-model.md",
            "skills/db11-plan/references/conversation-format.md",
            "skills/db11-plan/references/operations/start.md",
            "skills/db11-plan/references/operations/resume.md",
            "skills/db11-plan/references/operations/status.md",
            "skills/db11-plan/references/operations/discuss.md",
            "skills/db11-plan/references/operations/conclude.md",
            "skills/db11-journey/SKILL.md",
            "skills/db11-journey/agents/openai.yaml",
            "skills/db11-journey/references/concepts.md",
            "skills/db11-journey/references/wyrd-model.md",
            "skills/db11-journey/references/operations/start.md",
            "skills/db11-journey/references/operations/resume.md",
            "skills/db11-journey/references/operations/work.md",
            "skills/db11-journey/references/operations/advance.md",
            "skills/db11-journey/references/phases/definition.md",
            "skills/db11-journey/references/phases/planning.md",
            "skills/db11-journey/references/phases/implementation.md",
        },
    },
    "pi-codex-usage": {
        "name": "@debonzi/pi-codex-usage",
        "pi": {"extensions": ["./agents/pi/extensions/codex-usage/index.ts"]},
        "peers": {
            "@earendil-works/pi-coding-agent": "*",
            "@earendil-works/pi-tui": "*",
        },
        "files": {
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "agents/pi/extensions/codex-usage/README.md",
            "agents/pi/extensions/codex-usage/config.example.json",
            "agents/pi/extensions/codex-usage/core.ts",
            "agents/pi/extensions/codex-usage/index.ts",
        },
    },
    "pi-copilot-usage": {
        "name": "@debonzi/pi-copilot-usage",
        "pi": {"extensions": ["./agents/pi/extensions/copilot-usage/index.ts"]},
        "peers": {
            "@earendil-works/pi-coding-agent": "*",
            "@earendil-works/pi-tui": "*",
        },
        "files": {
            "README.md",
            "LICENSE",
            "NOTICES.md",
            "CHANGELOG.md",
            "agents/pi/extensions/copilot-usage/README.md",
            "agents/pi/extensions/copilot-usage/config.example.json",
            "agents/pi/extensions/copilot-usage/core.ts",
            "agents/pi/extensions/copilot-usage/index.ts",
        },
    },
}
EXPECTED_SKILL_NAMES = {"db11-plan", "db11-journey"}
EXECUTABLE_PATHS = {
    "db11-skills": set(),
    "pi-codex-usage": set(),
    "pi-copilot-usage": set(),
}
LIFECYCLE_SCRIPTS = {
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
}
RELATIVE_IMPORT = re.compile(r"\bfrom\s+['\"](\.[^'\"]+)['\"]")
SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
LOCKFILE = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))


def load_manifest(path: Path) -> dict:
    return json.loads((path / "package.json").read_text(encoding="utf-8"))


def locked_workspace_version(directory: str) -> str:
    return LOCKFILE["packages"][f"packages/{directory}"]["version"]


def assert_safe_relative(test: unittest.TestCase, value: str, label: str) -> PurePosixPath:
    path = PurePosixPath(value)
    test.assertFalse(path.is_absolute(), label)
    test.assertNotIn("..", path.parts, label)
    test.assertNotEqual(path, PurePosixPath("."), label)
    return path


def normalize_pack_json(output: str, expected_name: str) -> dict:
    payload = json.loads(output)
    candidates: list[dict] = []
    if isinstance(payload, list):
        candidates.extend(entry for entry in payload if isinstance(entry, dict))
    elif isinstance(payload, dict):
        if isinstance(payload.get("files"), list):
            candidates.append(payload)
        else:
            candidates.extend(entry for entry in payload.values() if isinstance(entry, dict))
    matches = [entry for entry in candidates if entry.get("name") == expected_name]
    if len(matches) != 1:
        raise AssertionError(
            f"npm pack returned {len(matches)} records for {expected_name}: {payload!r}"
        )
    if not isinstance(matches[0].get("files"), list):
        raise AssertionError(f"npm pack record has no files array: {matches[0]!r}")
    return matches[0]


class PackageManifestTests(unittest.TestCase):
    def test_root_is_a_private_workspace_coordinator(self) -> None:
        package = load_manifest(ROOT)
        self.assertEqual(package["name"], "db11-ai-tools-workspace")
        self.assertNotEqual(package["name"], "@debonzi/db11-ai-tools")
        self.assertNotEqual(package["name"], "@debonzi/dbz-ai-tools")
        self.assertIs(package["private"], True)
        self.assertEqual(package["type"], "module")
        self.assertEqual(package["workspaces"], ["packages/*"])
        for forbidden in ("version", "pi", "files", "publishConfig", "dependencies", "peerDependencies"):
            self.assertNotIn(forbidden, package)
        self.assertEqual(
            {path.name for path in PACKAGES.iterdir() if (path / "package.json").is_file()},
            set(EXPECTED_WORKSPACES),
        )

    def test_deprecated_resources_are_outside_active_workspaces(self) -> None:
        self.assertTrue((ROOT / "deprecated/db11-crew/package.json").is_file())
        self.assertTrue((ROOT / "deprecated/db11-spec/SKILL.md").is_file())
        self.assertFalse((PACKAGES / "db11-crew").exists())
        self.assertFalse((PACKAGES / "db11-skills/skills/db11-spec").exists())

    def test_publishable_manifests_have_exact_resource_boundaries(self) -> None:
        for directory, expected in EXPECTED_WORKSPACES.items():
            with self.subTest(package=expected["name"]):
                package_root = PACKAGES / directory
                package = load_manifest(package_root)
                self.assertEqual(package["name"], expected["name"])
                self.assertEqual(package["version"], locked_workspace_version(directory))
                self.assertRegex(package["version"], SEMVER)
                self.assertNotIn("private", package)
                self.assertIn("pi-package", package["keywords"])
                self.assertEqual(package["publishConfig"], {"access": "public"})
                self.assertEqual(
                    package["homepage"],
                    f"https://github.com/debonzi/db11-ai-tools/tree/main/packages/{directory}#readme",
                )
                self.assertEqual(
                    package["repository"],
                    {
                        "type": "git",
                        "url": "git+https://github.com/debonzi/db11-ai-tools.git",
                        "directory": f"packages/{directory}",
                    },
                )
                self.assertEqual(
                    package["bugs"],
                    {"url": "https://github.com/debonzi/db11-ai-tools/issues"},
                )
                self.assertEqual(package["pi"], expected["pi"])
                self.assertEqual(package.get("peerDependencies", {}), expected["peers"])
                self.assertEqual(set(package["files"]), expected["files"])
                self.assertTrue(LIFECYCLE_SCRIPTS.isdisjoint(package.get("scripts", {})))

                for relative in package["files"]:
                    path = assert_safe_relative(self, relative, f"{expected['name']}: {relative}")
                    resolved = (package_root / path).resolve()
                    self.assertTrue(resolved.is_relative_to(package_root.resolve()), relative)
                    self.assertTrue(resolved.is_file(), f"{expected['name']}: {relative}")

                for resource_type in ("skills", "extensions", "prompts", "themes"):
                    for relative in package["pi"].get(resource_type, []):
                        path = assert_safe_relative(
                            self, relative, f"{expected['name']} {resource_type}: {relative}"
                        )
                        resolved = (package_root / path).resolve()
                        self.assertTrue(resolved.is_relative_to(package_root.resolve()), relative)
                        self.assertTrue(resolved.exists(), f"{expected['name']}: {relative}")

    def test_pi_codex_usage_uses_db11_active_branding(self) -> None:
        package_root = PACKAGES / "pi-codex-usage"
        package = load_manifest(package_root)
        self.assertEqual(
            package["homepage"],
            "https://github.com/debonzi/db11-ai-tools/tree/main/packages/pi-codex-usage#readme",
        )
        self.assertEqual(
            package["repository"],
            {
                "type": "git",
                "url": "git+https://github.com/debonzi/db11-ai-tools.git",
                "directory": "packages/pi-codex-usage",
            },
        )
        self.assertEqual(
            package["bugs"],
            {"url": "https://github.com/debonzi/db11-ai-tools/issues"},
        )
        readme = (package_root / "README.md").read_text(encoding="utf-8")
        extension = (
            package_root / "agents/pi/extensions/codex-usage/index.ts"
        ).read_text(encoding="utf-8")
        self.assertNotIn("DBZ resources", readme)
        self.assertIn('"User-Agent": "db11-codex-usage"', extension)
        self.assertNotIn("dbz-codex-usage", extension)

    def test_pi_copilot_usage_uses_db11_active_branding(self) -> None:
        package_root = PACKAGES / "pi-copilot-usage"
        package = load_manifest(package_root)
        self.assertEqual(
            package["homepage"],
            "https://github.com/debonzi/db11-ai-tools/tree/main/packages/pi-copilot-usage#readme",
        )
        self.assertEqual(
            package["repository"],
            {
                "type": "git",
                "url": "git+https://github.com/debonzi/db11-ai-tools.git",
                "directory": "packages/pi-copilot-usage",
            },
        )
        extension = (
            package_root / "agents/pi/extensions/copilot-usage/index.ts"
        ).read_text(encoding="utf-8")
        self.assertIn('"User-Agent": "db11-copilot-usage"', extension)
        self.assertNotIn("dbz-copilot-usage", extension)

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

        self.assertEqual(names, EXPECTED_SKILL_NAMES)
        self.assertFalse(any(path.parent.name == "dbz-ai-tools-setup" for path in PACKAGES.rglob("SKILL.md")))

    def test_db11_journey_uses_progressive_phase_references(self) -> None:
        journey_root = PACKAGES / "db11-skills/skills/db11-journey"
        skill = (journey_root / "SKILL.md").read_text(encoding="utf-8")

        for relative in (
            "references/concepts.md",
            "references/wyrd-model.md",
            "references/operations/start.md",
            "references/operations/resume.md",
            "references/operations/work.md",
            "references/operations/advance.md",
            "references/phases/definition.md",
            "references/phases/planning.md",
            "references/phases/implementation.md",
        ):
            self.assertIn(relative, skill)
            self.assertTrue((journey_root / relative).is_file(), relative)

        for requirement in (
            "Do not preload every reference",
            "journey:<codename>",
            "phase:definition",
            "phase:planning",
            "phase:implementation",
            "Never read or edit `.wyrd/`",
            "Never delegate work to other agents automatically",
        ):
            self.assertIn(requirement, skill)

        self.assertLess(len(skill), 6_000)

    def test_bundled_python_entry_points_remain_executable(self) -> None:
        for directory, paths in EXECUTABLE_PATHS.items():
            for relative in paths:
                path = PACKAGES / directory / relative
                with self.subTest(path=path):
                    self.assertTrue(path.is_file())
                    self.assertTrue(path.stat().st_mode & stat.S_IXUSR)


class PackageArchiveTests(unittest.TestCase):
    def pack_workspace(self, directory: str, expected: dict) -> tuple[dict, Path, tempfile.TemporaryDirectory]:
        temporary = tempfile.TemporaryDirectory(prefix=f"pack-{directory}-")
        self.addCleanup(temporary.cleanup)
        destination = Path(temporary.name)
        result = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--ignore-scripts",
                "--pack-destination",
                str(destination),
            ],
            cwd=PACKAGES / directory,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        details = normalize_pack_json(result.stdout, expected["name"])
        archive = destination / details["filename"]
        self.assertTrue(archive.is_file(), archive)
        return details, archive, temporary

    def test_each_workspace_has_an_exact_minimal_archive(self) -> None:
        all_expected = {
            directory: {"package.json", *expected["files"]}
            for directory, expected in EXPECTED_WORKSPACES.items()
        }
        for directory, expected in EXPECTED_WORKSPACES.items():
            with self.subTest(package=expected["name"]):
                details, archive, _temporary = self.pack_workspace(directory, expected)
                self.assertEqual(details["version"], locked_workspace_version(directory))
                reported = {entry["path"]: entry for entry in details["files"]}
                self.assertEqual(set(reported), all_expected[directory])

                with tarfile.open(archive, "r:gz") as tar:
                    members = {
                        member.name.removeprefix("package/"): member
                        for member in tar.getmembers()
                        if member.isfile()
                    }
                    self.assertEqual(set(members), all_expected[directory])
                    self.assertFalse(any(member.issym() or member.islnk() for member in tar.getmembers()))
                    manifest_member = tar.extractfile("package/package.json")
                    self.assertIsNotNone(manifest_member)
                    packed_manifest = json.load(io.TextIOWrapper(manifest_member, encoding="utf-8"))

                self.assertEqual(packed_manifest["name"], expected["name"])
                self.assertEqual(packed_manifest["version"], locked_workspace_version(directory))
                self.assertEqual(packed_manifest["pi"], expected["pi"])
                self.assertEqual(set(packed_manifest["files"]), expected["files"])

                for path in all_expected[directory]:
                    expected_executable = path in EXECUTABLE_PATHS[directory]
                    self.assertEqual(bool(reported[path]["mode"] & stat.S_IXUSR), expected_executable, path)
                    self.assertEqual(bool(members[path].mode & stat.S_IXUSR), expected_executable, path)

                prohibited_parts = {
                    ".changeset",
                    ".drafts",
                    ".github",
                    "__pycache__",
                    "cache",
                    "caches",
                    "credentials",
                    "histories",
                    "history",
                    "sessions",
                    "tests",
                }
                for path in members:
                    lowered = path.lower()
                    parts = {part.lower() for part in PurePosixPath(path).parts}
                    self.assertTrue(parts.isdisjoint(prohibited_parts), path)
                    self.assertFalse(lowered.endswith((".pyc", ".test.ts")), path)
                    self.assertNotIn("smoke_db11_crew.md", lowered)
                    self.assertNotIn("trust.json", lowered)
                    self.assertNotIn("dbz-ai-tools-setup", lowered)
                    self.assertNotIn("skills/db11-spec", lowered)
                    self.assertNotIn("skills/db11-crew", lowered)
                    self.assertNotIn("extensions/db11-crew-events", lowered)
                    self.assertNotIn("skills/dbz-crew", lowered)
                    self.assertNotIn("skills/dbz-crew-setup", lowered)
                    self.assertNotIn("extensions/dbz-crew-events", lowered)
                    self.assertNotIn("configure.py", lowered)

                other_files = set().union(
                    *(paths for owner, paths in all_expected.items() if owner != directory)
                )
                self.assertTrue(set(members).isdisjoint(other_files - all_expected[directory]))
                self.assert_runtime_imports_are_packed(directory, set(members))
                self.assert_manifest_resources_are_packed(packed_manifest, set(members))

    def assert_runtime_imports_are_packed(self, directory: str, packed: set[str]) -> None:
        package_root = PACKAGES / directory
        for source_path in sorted(path for path in packed if path.endswith((".ts", ".js"))):
            source = (package_root / source_path).read_text(encoding="utf-8")
            for imported in RELATIVE_IMPORT.findall(source):
                resolved = (PurePosixPath(source_path).parent / imported)
                normalized = PurePosixPath(*[part for part in resolved.parts if part != "."])
                self.assertNotIn("..", normalized.parts, f"{source_path}: {imported}")
                self.assertIn(normalized.as_posix(), packed, f"{source_path}: {imported}")

    def assert_manifest_resources_are_packed(self, manifest: dict, packed: set[str]) -> None:
        for extension in manifest["pi"].get("extensions", []):
            self.assertIn(PurePosixPath(extension).as_posix().removeprefix("./"), packed)
        for skill_root in manifest["pi"].get("skills", []):
            prefix = PurePosixPath(skill_root).as_posix().removeprefix("./").rstrip("/") + "/"
            self.assertTrue(any(path.startswith(prefix) and path.endswith("/SKILL.md") for path in packed))


if __name__ == "__main__":
    unittest.main()
