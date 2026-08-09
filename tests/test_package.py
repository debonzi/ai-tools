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
            "skills/db11-spec/SKILL.md",
            "skills/db11-spec/agents/openai.yaml",
        },
    },
    "db11-crew": {
        "name": "@debonzi/db11-crew",
        "pi": {
            "skills": ["./skills"],
            "extensions": ["./agents/pi/extensions/db11-crew-events/index.ts"],
        },
        "peers": {"@earendil-works/pi-coding-agent": "*"},
        "files": {
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills/db11-crew/SKILL.md",
            "skills/db11-crew/references/CLI.md",
            "skills/db11-crew/scripts/db11-crew",
            "skills/db11-crew-setup/SKILL.md",
            "agents/pi/extensions/db11-crew-events/README.md",
            "agents/pi/extensions/db11-crew-events/index.ts",
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
}
EXPECTED_SKILL_NAMES = {"db11-spec", "db11-crew", "db11-crew-setup"}
EXECUTABLE_PATHS = {
    "db11-skills": set(),
    "db11-crew": {"skills/db11-crew/scripts/db11-crew"},
    "pi-codex-usage": set(),
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

    def test_setup_is_explicit_scoped_and_confirmation_gated(self) -> None:
        setup = (PACKAGES / "db11-crew/skills/db11-crew-setup/SKILL.md").read_text(
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
            "pi list --no-approve",
            "dbz-crew-events",
            "broken symlinks",
            "~/.local/state/dbz-crew",
            "explicit confirmation",
            "/reload",
        ):
            self.assertIn(requirement, setup)
        self.assertNotIn("@debonzi/dbz-ai-tools", setup)
        self.assertNotIn("configure.py", setup)
        self.assertFalse((ROOT / "skills/dbz-ai-tools-setup/SKILL.md").exists())
        self.assertFalse((ROOT / "skills/dbz-ai-tools-setup/scripts/configure.py").exists())

    def test_db11_crew_guidance_covers_install_cutover_events_and_lifecycle(self) -> None:
        crew_root = PACKAGES / "db11-crew"
        readme = (crew_root / "README.md").read_text(encoding="utf-8")
        skill = (crew_root / "skills/db11-crew/SKILL.md").read_text(encoding="utf-8")
        cli = (crew_root / "skills/db11-crew/references/CLI.md").read_text(encoding="utf-8")
        extension = (
            crew_root / "agents/pi/extensions/db11-crew-events/README.md"
        ).read_text(encoding="utf-8")
        smoke = (crew_root / "tests/SMOKE_DB11_CREW.md").read_text(encoding="utf-8")

        for requirement in (
            "For a clean installation",
            "hard namespace cutover",
            "pi list --no-approve",
            "db11-crew-event-delivered",
            "Rebase, local non-fast-forward integration, and cleanup",
            "~/.local/state/dbz-crew",
        ):
            self.assertIn(requirement, readme)
        for requirement in (
            "pi list --no-approve",
            "dbz-crew-events",
            "preserved `~/.local/state/dbz-crew`",
            "delivers completion only to the original principal session as a follow-up",
        ):
            self.assertIn(requirement, skill)
        for requirement in (
            "## Implementation lifecycle",
            "local non-fast-forward merge",
            "There is no state migration or bridge",
            "Former delivered markers do not acknowledge DB11 events",
        ):
            self.assertIn(requirement, cli)
        for requirement in (
            "never reads or changes `~/.local/state/dbz-crew`",
            "does not treat `dbz-crew-event-delivered` entries as DB11 acknowledgements",
            "at least once",
        ):
            self.assertIn(requirement, extension)
        for heading in (
            "## 1. Automated baseline and clean package installation",
            "## 2. Installed-resource and cutover audit",
            "## 3. Hard-cutover and untouched-state checks",
            "## 4. Interactive implementation lifecycle and event delivery",
            "## 5. Read-only lifecycle",
        ):
            self.assertIn(heading, smoke)

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
