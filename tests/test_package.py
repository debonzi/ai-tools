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
DEPRECATED = ROOT / "deprecated"
EXPECTED_WORKSPACES = {
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
    "pi-context-meter": {
        "name": "@debonzi/pi-context-meter",
        "pi": {"extensions": ["./agents/pi/extensions/pi-context-meter/index.ts"]},
        "peers": {
            "@earendil-works/pi-coding-agent": "*",
            "typebox": "*",
        },
        "files": {
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "agents/pi/extensions/pi-context-meter/index.ts",
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

    def test_lockfile_contains_only_active_workspaces(self) -> None:
        entries = LOCKFILE["packages"]
        self.assertEqual(entries[""]["workspaces"], ["packages/*"])
        self.assertEqual(
            {path for path in entries if path.startswith("packages/")},
            {f"packages/{directory}" for directory in EXPECTED_WORKSPACES},
        )
        self.assertFalse(any(path.startswith("deprecated/") for path in entries))
        self.assertNotIn("node_modules/@debonzi/db11-skills", entries)

    def test_deprecated_resources_remain_separate_from_active_resources(self) -> None:
        archived_package = DEPRECATED / "db11-skills"
        manifest = load_manifest(archived_package)
        self.assertEqual(manifest["name"], "@debonzi/db11-skills")
        self.assertIs(manifest.get("private"), True)
        self.assertFalse((PACKAGES / "db11-skills").exists())
        for skill in ("db11-plan", "db11-shipit", "db11-journey"):
            with self.subTest(skill=skill):
                self.assertTrue((archived_package / "skills" / skill / "SKILL.md").is_file())
                self.assertFalse((ROOT / "skills" / skill).exists())

        self.assertTrue((DEPRECATED / "context-footer.ts").is_file())
        self.assertTrue((DEPRECATED / "db11-squad/ANOTATIONS.md").is_file())
        extensions = ROOT / "agents/pi/extensions"
        self.assertFalse((extensions / "context-footer.ts").exists())
        self.assertFalse((extensions / "db11-squad").exists())

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
                self.assertEqual(package.get("dependencies", {}), expected.get("dependencies", {}))
                self.assertEqual(
                    package.get("bundledDependencies", []),
                    expected.get("bundled_dependencies", []),
                )
                self.assertEqual(
                    package.get("devDependencies", {}),
                    expected.get("dev_dependencies", {}),
                )
                self.assertEqual(set(package["files"]), expected["files"])
                self.assertNotIn("bin", package)
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


class PackageArchiveTests(unittest.TestCase):
    def expected_archive_paths(self, directory: str, expected: dict) -> set[str]:
        return {"package.json", *expected["files"]}

    def pack_workspace(self, directory: str, expected: dict) -> tuple[dict, Path, tempfile.TemporaryDirectory]:
        temporary = tempfile.TemporaryDirectory(prefix=f"pack-{directory}-")
        self.addCleanup(temporary.cleanup)
        destination = Path(temporary.name)
        package_root = PACKAGES / directory
        result = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--ignore-scripts",
                "--pack-destination",
                str(destination),
            ],
            cwd=package_root,
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
            directory: self.expected_archive_paths(directory, expected)
            for directory, expected in EXPECTED_WORKSPACES.items()
        }
        for directory, expected in EXPECTED_WORKSPACES.items():
            with self.subTest(package=expected["name"]):
                details, archive, _temporary = self.pack_workspace(directory, expected)
                self.assertEqual(details["version"], locked_workspace_version(directory))
                reported = {entry["path"]: entry for entry in details["files"]}
                self.assertEqual(set(reported), all_expected[directory])
                root_owned = {path for path in reported if not path.startswith("node_modules/")}
                self.assertEqual(root_owned, {"package.json", *expected["files"]})
                bundled = set(reported) - root_owned
                self.assertFalse(bundled)

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
                    self.assertFalse(reported[path]["mode"] & stat.S_IXUSR, path)
                    self.assertFalse(members[path].mode & stat.S_IXUSR, path)

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
                    self.assertTrue(parts.isdisjoint(prohibited_parts - {"cache", "caches"}), path)
                    if "cache" in parts or "caches" in parts:
                        self.assertTrue(path.startswith("node_modules/"), path)
                    self.assertFalse(lowered.endswith((".pyc", ".test.ts")), path)
                    self.assertNotIn("trust.json", lowered)

                other_files = set().union(
                    *(paths for owner, paths in all_expected.items() if owner != directory)
                )
                self.assertTrue(set(members).isdisjoint(other_files - all_expected[directory]))
                self.assert_runtime_imports_are_packed(directory, root_owned)
                self.assert_manifest_resources_are_packed(packed_manifest, set(members))

    def assert_runtime_imports_are_packed(self, directory: str, packed: set[str]) -> None:
        package_root = PACKAGES / directory
        for source_path in sorted(path for path in packed if path.endswith((".ts", ".js"))):
            source = (package_root / source_path).read_text(encoding="utf-8")
            for imported in RELATIVE_IMPORT.findall(source):
                resolved = PurePosixPath(source_path).parent / imported
                normalized_parts: list[str] = []
                for part in resolved.parts:
                    if part == ".":
                        continue
                    if part == "..":
                        self.assertTrue(normalized_parts, f"{source_path}: {imported}")
                        normalized_parts.pop()
                    else:
                        normalized_parts.append(part)
                normalized = PurePosixPath(*normalized_parts)
                self.assertIn(normalized.as_posix(), packed, f"{source_path}: {imported}")

    def assert_manifest_resources_are_packed(self, manifest: dict, packed: set[str]) -> None:
        for extension in manifest["pi"].get("extensions", []):
            self.assertIn(PurePosixPath(extension).as_posix().removeprefix("./"), packed)


if __name__ == "__main__":
    unittest.main()
