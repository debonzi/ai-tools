from __future__ import annotations

import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / "packages"
EXPECTED_WORKSPACES = {
    "db11-crew": {
        "name": "@debonzi/db11-crew",
        "version": "0.2.0",
        "pi": {
            "extensions": ["./agents/pi/extensions/db11-crew/index.ts"],
            "skills": ["./skills"],
        },
        "peers": {
            "@earendil-works/pi-coding-agent": "*",
            "@earendil-works/pi-ai": "*",
            "@earendil-works/pi-tui": "*",
            "typebox": "*",
        },
        "dev_dependencies": {
            "@types/node": "24.13.3",
            "typescript": "7.0.2",
        },
        "files": {
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "config/config.example.json",
            "docs/operations.md",
            "skills/db11-crew/SKILL.md",
            "skills/db11-crew/references/README.md",
            "skills/db11-crew/references/dispatch.md",
            "skills/db11-crew/references/operations.md",
            "skills/db11-crew/references/safety.md",
            "skills/db11-crew-setup/SKILL.md",
            "skills/db11-crew-setup/references/README.md",
            "skills/db11-crew-setup/references/diagnostics.md",
            "skills/db11-crew-setup/references/settings.md",
            "skills/db11-crew-setup/references/herdr-integration.md",
            "skills/db11-crew-setup/references/activation-reload.md",
            "agents/pi/extensions/db11-crew/index.ts",
            "agents/pi/extensions/db11-crew-member/index.ts",
            "agents/pi/roles/manifest.json",
            "agents/pi/roles/scout.md",
            "agents/pi/roles/planner.md",
            "agents/pi/roles/builder.md",
            "src/adapters/git/disposition.ts",
            "src/adapters/git/isolation.ts",
            "src/adapters/herdr/adapter.ts",
            "src/adapters/herdr/contracts.ts",
            "src/adapters/herdr/protocol17.ts",
            "src/adapters/herdr/transport.ts",
            "src/adapters/process.ts",
            "src/adapters/pi/launcher.ts",
            "src/config/config.ts",
            "src/config/store.ts",
            "src/companion/extension.ts",
            "src/companion/protocol.ts",
            "src/delivery/service.ts",
            "src/delivery/transient.ts",
            "src/crewlead/activation.ts",
            "src/crewlead/extension.ts",
            "src/crewlead/runtime.ts",
            "src/orchestration/disposition.ts",
            "src/orchestration/lifecycle.ts",
            "src/orchestration/recovery.ts",
            "src/protocol/compatibility.ts",
            "src/protocol/contracts.ts",
            "src/protocol/limits.ts",
            "src/protocol/validate.ts",
            "src/roles/resolve.ts",
            "src/security/binding.ts",
            "src/security/capabilities.ts",
            "src/security/errors.ts",
            "src/security/json.ts",
            "src/security/redaction.ts",
            "src/setup/commands.ts",
            "src/setup/diagnostics.ts",
            "src/state/claims.ts",
            "src/state/contracts.ts",
            "src/state/filesystem.ts",
            "src/state/leases.ts",
            "src/state/store.ts",
            "src/ui/observability.ts",
        },
    },
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
            "skills/db11-shipit/SKILL.md",
            "skills/db11-shipit/agents/openai.yaml",
            "skills/db11-shipit/assets/implementation-ticket-body.md",
            "skills/db11-shipit/assets/implementation-task-body.md",
            "skills/db11-shipit/references/protocol.md",
            "skills/db11-shipit/references/wyrd-model.md",
            "skills/db11-shipit/references/conversation-format.md",
            "skills/db11-shipit/references/operations/start.md",
            "skills/db11-shipit/references/operations/resume.md",
            "skills/db11-shipit/references/operations/status.md",
            "skills/db11-shipit/references/operations/plan.md",
            "skills/db11-shipit/references/operations/materialize.md",
            "skills/db11-shipit/references/operations/work.md",
            "skills/db11-shipit/references/operations/conclude.md",
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
EXPECTED_SKILL_NAMES = {
    "db11-crew",
    "db11-crew-setup",
    "db11-plan",
    "db11-shipit",
    "db11-journey",
}
EXECUTABLE_PATHS = {
    "db11-crew": set(),
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

    def test_deprecated_resources_remain_separate_from_active_workspaces(self) -> None:
        self.assertTrue((ROOT / "deprecated/db11-crew/package.json").is_file())
        self.assertTrue((ROOT / "deprecated/db11-spec/SKILL.md").is_file())
        self.assertTrue((PACKAGES / "db11-crew/package.json").is_file())
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

    def test_db11_shipit_uses_progressive_operation_references(self) -> None:
        shipit_root = PACKAGES / "db11-skills/skills/db11-shipit"
        skill = (shipit_root / "SKILL.md").read_text(encoding="utf-8")

        for relative in (
            "references/protocol.md",
            "references/wyrd-model.md",
            "references/conversation-format.md",
            "references/operations/start.md",
            "references/operations/resume.md",
            "references/operations/status.md",
            "references/operations/plan.md",
            "references/operations/materialize.md",
            "references/operations/work.md",
            "references/operations/conclude.md",
            "assets/implementation-ticket-body.md",
            "assets/implementation-task-body.md",
        ):
            self.assertIn(relative, skill)
            self.assertTrue((shipit_root / relative).is_file(), relative)

        for requirement in (
            "Do not preload every reference",
            "plan:<plan-ticket-id>",
            "protocol:db11_shipit",
            "Only `work` authorizes",
            "Never read or edit `.wyrd/`",
            "Do not commit, push, deploy",
        ):
            self.assertIn(requirement, skill)

        self.assertLess(len(skill), 6_000)

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


class Db11CrewPackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.package_root = PACKAGES / "db11-crew"
        self.manifest = load_manifest(self.package_root)

    def test_manifest_reserves_only_the_approved_pi_entry_points(self) -> None:
        self.assertEqual(self.manifest["name"], "@debonzi/db11-crew")
        self.assertEqual(self.manifest["version"], "0.2.0")
        self.assertEqual(
            self.manifest["pi"],
            {
                "extensions": ["./agents/pi/extensions/db11-crew/index.ts"],
                "skills": ["./skills"],
            },
        )
        self.assertNotIn(
            "./agents/pi/extensions/db11-crew-member/index.ts",
            self.manifest["pi"]["extensions"],
        )
        self.assertNotIn("bin", self.manifest)
        self.assertTrue(LIFECYCLE_SCRIPTS.isdisjoint(self.manifest.get("scripts", {})))

    def test_entry_points_remain_source_only_and_member_requires_explicit_loading(self) -> None:
        expected = {
            "agents/pi/extensions/db11-crew/index.ts": (
                'import { fileURLToPath } from "node:url";\n\n'
                'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\n'
                'import { installCrewleadExtension } from "../../../../src/crewlead/extension.ts";\n\n'
                "export default function db11Crew(pi: ExtensionAPI): void {\n"
                "  installCrewleadExtension(pi, { extensionPath: fileURLToPath(import.meta.url) });\n"
                "}\n"
            ),
            "agents/pi/extensions/db11-crew-member/index.ts": (
                'import { fileURLToPath } from "node:url";\n\n'
                'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\n'
                'import { installMemberCompanion } from "../../../../src/companion/extension.ts";\n\n'
                "export default function db11CrewMember(pi: ExtensionAPI): void {\n"
                "  installMemberCompanion(pi, { extensionPath: fileURLToPath(import.meta.url) });\n"
                "}\n"
            ),
        }
        for relative, content in expected.items():
            with self.subTest(path=relative):
                self.assertEqual(
                    (self.package_root / relative).read_text(encoding="utf-8"), content
                )

    def test_approved_component_and_test_boundaries_are_present(self) -> None:
        expected_directories = {
            "src/protocol": {
                "compatibility.ts",
                "contracts.ts",
                "limits.ts",
                "validate.ts",
            },
            "src/config": {"config.ts", "store.ts"},
            "src/security": {
                "binding.ts",
                "capabilities.ts",
                "errors.ts",
                "json.ts",
                "redaction.ts",
            },
            "src/state": {
                "claims.ts",
                "contracts.ts",
                "filesystem.ts",
                "leases.ts",
                "store.ts",
            },
            "src/roles": {"resolve.ts"},
            "src/adapters/herdr": {
                "adapter.ts",
                "contracts.ts",
                "protocol17.ts",
                "transport.ts",
            },
            "src/adapters/pi": {".gitkeep", "launcher.ts"},
            "src/adapters/git": {"disposition.ts", "isolation.ts"},
            "src/adapters/wyrd": set(),
            "src/adapters/web": {".gitkeep"},
            "src/orchestration": {"disposition.ts", "lifecycle.ts", "recovery.ts"},
            "src/setup": {"commands.ts", "diagnostics.ts"},
            "src/crewlead": {".gitkeep", "activation.ts", "extension.ts", "runtime.ts"},
            "src/companion": {".gitkeep", "extension.ts", "protocol.ts"},
            "src/delivery": {".gitkeep", "service.ts", "transient.ts"},
            "src/ui": {".gitkeep", "observability.ts"},
            "tests/unit": {
                "activation.test.ts",
                "compatibility.test.ts",
                "config.test.ts",
                "contracts.test.ts",
                "lifecycle.test.ts",
                "resource-identity.test.ts",
                "roles.test.ts",
                "setup.test.ts",
            },
            "tests/security": {
                "capabilities.test.ts",
                "claims.test.ts",
                "filesystem.test.ts",
                "helpers.ts",
                "store.test.ts",
            },
            "tests/component": {
                "companion.test.ts",
                "crewlead.test.ts",
                "delivery-ui.test.ts",
                "herdr.test.ts",
                "member-launch.test.ts",
                "setup-commands.test.ts",
            },
            "tests/integration": {"disposition.test.ts", "git-wyrd.test.ts"},
            "tests/fixtures": {".gitkeep", "archive-allowlist.txt"},
            "tests/smoke": {".gitkeep"},
        }
        for relative, expected_files in expected_directories.items():
            with self.subTest(path=relative):
                directory = self.package_root / relative
                self.assertTrue(directory.is_dir(), relative)
                self.assertEqual({path.name for path in directory.iterdir()}, expected_files, relative)

    def test_crew_skills_use_progressive_policy_and_setup_references(self) -> None:
        policy_root = self.package_root / "skills/db11-crew"
        setup_root = self.package_root / "skills/db11-crew-setup"
        policy = (policy_root / "SKILL.md").read_text(encoding="utf-8")
        setup = (setup_root / "SKILL.md").read_text(encoding="utf-8")

        for relative in (
            "references/dispatch.md",
            "references/operations.md",
            "references/safety.md",
        ):
            self.assertIn(relative, policy)
            self.assertTrue((policy_root / relative).is_file(), relative)
        for relative in (
            "references/diagnostics.md",
            "references/settings.md",
            "references/herdr-integration.md",
            "references/activation-reload.md",
        ):
            self.assertIn(relative, setup)
            self.assertTrue((setup_root / relative).is_file(), relative)
        self.assertFalse((setup_root / "references/cutover-rollback.md").exists())

        policy_frontmatter = re.match(r"^---\n(.*?)\n---\n", policy, re.DOTALL)
        self.assertIsNotNone(policy_frontmatter)
        self.assertRegex(
            policy_frontmatter.group(1),
            r"(?m)^disable-model-invocation:\s*true$",
        )
        self.assertNotIn("disable-model-invocation: true", setup)
        for requirement in (
            "passive by default",
            "exact, image-free `/skill:db11-crew`",
            "`interactive` or `rpc`",
            "is a designation request",
            "Never infer activation",
            "permanently designates only the exact current Pi session",
            "managed-member sessions do not inherit or transfer",
        ):
            self.assertIn(requirement, policy)

        self.assertIn("Never recreate orchestration with shell commands", policy)
        self.assertIn("read-only", setup.lower())
        self.assertIn("/db11-crew-setup apply", setup)
        self.assertNotIn("herdr integration install pi\n```", setup)
        self.assertLess(len(policy), 6_000)
        self.assertLess(len(setup), 6_000)

        operations = (self.package_root / "docs/operations.md").read_text(encoding="utf-8")
        for heading in (
            "Supported installation",
            "Trust",
            "Support matrix",
            "Configuration v2",
            "Canonical identity and read-only diagnosis",
            "Explicit activation",
            "Exact same-session reload and restoration",
            "Current-resource persistence",
            "Safe operations",
            "Non-goals",
        ):
            self.assertIn(f"## {heading}", operations)

    def test_current_delivery_surfaces_use_only_canonical_resource_identity(self) -> None:
        canonical_surfaces = {
            "root README": ROOT / "README.md",
            "package README": self.package_root / "README.md",
            "operations": self.package_root / "docs/operations.md",
            "activation and reload": (
                self.package_root
                / "skills/db11-crew-setup/references/activation-reload.md"
            ),
            "changelog": self.package_root / "CHANGELOG.md",
            "changeset": ROOT / ".changeset/restore-db11-crew.md",
            "release guide": ROOT / "docs/releasing.md",
        }
        for label, path in canonical_surfaces.items():
            with self.subTest(surface=label):
                text = path.read_text(encoding="utf-8")
                self.assertIn("`~/.local/state/db11-crew`", text)
                self.assertIn("`refs/heads/db11-crew/<run-id>`", text)

        obsolete_guidance = (
            "db11-crew-v2",
            "cutover-rollback.md",
            "hard cutover",
            "hard-cutover",
            "old-worker quiescence",
            "old-runtime quiescence",
            "generation reassessment",
            "noncanonical residue",
        )
        guidance_paths = [
            ROOT / "README.md",
            ROOT / "docs/releasing.md",
            *self.package_root.rglob("*.md"),
        ]
        for path in guidance_paths:
            text = path.read_text(encoding="utf-8").lower()
            for obsolete in obsolete_guidance:
                with self.subTest(path=path, obsolete=obsolete):
                    self.assertNotIn(obsolete, text)

        package_files = set(self.manifest["files"])
        self.assertIn(
            "skills/db11-crew-setup/references/activation-reload.md",
            package_files,
        )
        self.assertNotIn(
            "skills/db11-crew-setup/references/cutover-rollback.md",
            package_files,
        )
        for source in (self.package_root / "src").rglob("*.ts"):
            with self.subTest(source=source):
                self.assertNotIn(
                    "db11-crew-v2",
                    source.read_text(encoding="utf-8"),
                )

    def test_bundle_materializer_uses_the_locked_production_closure(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/materialize_bundle.py"),
                "--package",
                "db11-crew",
                "--print-plan",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        lock_keys = [line for line in result.stdout.splitlines() if line]
        self.assertEqual(lock_keys, [])
        self.assertNotIn("node_modules/typescript", lock_keys)
        self.assertFalse(any("@types/node" in key for key in lock_keys))
        for lock_key in lock_keys:
            locked = LOCKFILE["packages"][lock_key]
            self.assertIn("integrity", locked, lock_key)
            self.assertIn("resolved", locked, lock_key)

    def test_role_and_configuration_resources_are_strict_versioned_contracts(self) -> None:
        role_root = self.package_root / "agents/pi/roles"
        role_manifest = json.loads((role_root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(role_manifest["schemaVersion"], 2)
        self.assertEqual(role_manifest["package"], {"name": "@debonzi/db11-crew", "version": "0.2.0"})
        self.assertEqual([role["id"] for role in role_manifest["roles"]], ["scout", "planner", "builder"])
        self.assertEqual(len(role_manifest["roles"]), 3)
        for role in role_manifest["roles"]:
            self.assertEqual(role["profileVersion"], 2)
            profile = self.package_root / role["profilePath"]
            self.assertTrue(profile.is_file(), profile)
            text = profile.read_text(encoding="utf-8").lower()
            self.assertNotIn("placeholder", text)
            self.assertIn("cooperative policy", text)
            for obsolete in ("requiredCapabilities", "capabilities", "tools", "activeTools", "readinessChecks", "providerVariant"):
                self.assertNotIn(obsolete, role)

        config = json.loads(
            (self.package_root / "config/config.example.json").read_text(encoding="utf-8")
        )
        self.assertEqual(config["schemaVersion"], 2)
        self.assertEqual(config["limits"], {
            "maxActiveMembers": 4,
            "maxOpenMemberResources": 6,
            "maxQueuedDelegations": 6,
        })
        self.assertEqual(config["retention"]["policy"], "auto_close")
        self.assertNotIn("scoutWeb", config)


class PackageArchiveTests(unittest.TestCase):
    def expected_archive_paths(self, directory: str, expected: dict) -> set[str]:
        if directory != "db11-crew":
            return {"package.json", *expected["files"]}
        allowlist = PACKAGES / directory / "tests/fixtures/archive-allowlist.txt"
        paths = {
            line
            for line in allowlist.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#")
        }
        self.assertTrue(paths, allowlist)
        return paths

    def pack_workspace(self, directory: str, expected: dict) -> tuple[dict, Path, tempfile.TemporaryDirectory]:
        temporary = tempfile.TemporaryDirectory(prefix=f"pack-{directory}-")
        self.addCleanup(temporary.cleanup)
        destination = Path(temporary.name)
        package_root = PACKAGES / directory
        if directory == "db11-crew":
            package_root = destination / "staging"
            shutil.copytree(
                PACKAGES / directory,
                package_root,
                ignore=shutil.ignore_patterns("node_modules", "__pycache__"),
            )
            staged = subprocess.run(
                [
                    "python3",
                    str(ROOT / "scripts/materialize_bundle.py"),
                    "--package",
                    directory,
                    "--destination-root",
                    str(package_root),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(staged.returncode, 0, staged.stderr or staged.stdout)
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
                    self.assertTrue(parts.isdisjoint(prohibited_parts - {"cache", "caches"}), path)
                    if "cache" in parts or "caches" in parts:
                        self.assertTrue(path.startswith("node_modules/"), path)
                    self.assertFalse(lowered.endswith((".pyc", ".test.ts")), path)
                    self.assertNotIn("smoke_db11_crew.md", lowered)
                    self.assertNotIn("trust.json", lowered)
                    self.assertNotIn("dbz-ai-tools-setup", lowered)
                    self.assertNotIn("skills/db11-spec", lowered)
                    self.assertNotIn("extensions/db11-crew-events", lowered)
                    self.assertNotIn("skills/dbz-crew", lowered)
                    self.assertNotIn("skills/dbz-crew-setup", lowered)
                    self.assertNotIn("extensions/dbz-crew-events", lowered)
                    self.assertNotIn("configure.py", lowered)

                other_files = set().union(
                    *(paths for owner, paths in all_expected.items() if owner != directory)
                )
                self.assertTrue(set(members).isdisjoint(other_files - all_expected[directory]))
                self.assert_runtime_imports_are_packed(directory, root_owned)
                self.assert_manifest_resources_are_packed(packed_manifest, set(members))
                if directory == "db11-crew":
                    self.assertNotIn("dependencies", packed_manifest)
                    self.assertNotIn("bundledDependencies", packed_manifest)
                    self.assertNotIn("bin", packed_manifest)

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
        for skill_root in manifest["pi"].get("skills", []):
            prefix = PurePosixPath(skill_root).as_posix().removeprefix("./").rstrip("/") + "/"
            self.assertTrue(any(path.startswith(prefix) and path.endswith("/SKILL.md") for path in packed))


if __name__ == "__main__":
    unittest.main()
