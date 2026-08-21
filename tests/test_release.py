from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
RELEASE_SCRIPT = ROOT / "scripts" / "release_identity.py"
SPEC = importlib.util.spec_from_file_location("release_identity", RELEASE_SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RELEASE_IDENTITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RELEASE_IDENTITY
SPEC.loader.exec_module(RELEASE_IDENTITY)

EXPECTED = {
    "db11-crew": ("packages/db11-crew", "@debonzi/db11-crew"),
    "db11-skills": ("packages/db11-skills", "@debonzi/db11-skills"),
    "pi-codex-usage": ("packages/pi-codex-usage", "@debonzi/pi-codex-usage"),
    "pi-copilot-usage": (
        "packages/pi-copilot-usage",
        "@debonzi/pi-copilot-usage",
    ),
}


class ReleaseIdentityTests(unittest.TestCase):
    def test_selector_allowlist_has_exact_fixed_mappings(self) -> None:
        self.assertEqual(set(RELEASE_IDENTITY.PACKAGE_IDENTITIES), set(EXPECTED))
        for selector, (workspace, npm_name) in EXPECTED.items():
            identity = RELEASE_IDENTITY.PACKAGE_IDENTITIES[selector]
            self.assertEqual(identity.selector, selector)
            self.assertEqual(identity.workspace, workspace)
            self.assertEqual(identity.npm_name, npm_name)

    def test_valid_tags_resolve_to_one_fixed_workspace(self) -> None:
        for selector, (workspace, npm_name) in EXPECTED.items():
            with self.subTest(selector=selector):
                result = RELEASE_IDENTITY.parse_tag(f"{selector}-v1.2.3")
                self.assertEqual(result["selector"], selector)
                self.assertEqual(result["workspace"], workspace)
                self.assertEqual(result["npm_name"], npm_name)
                self.assertEqual(result["version"], "1.2.3")

    def test_malformed_and_unknown_release_identities_fail_closed(self) -> None:
        invalid_tags = (
            "v1.2.3",
            "dbz-ai-tools-v1.2.3",
            "dbz-skills-v1.2.3",
            "dbz-crew-v1.2.3",
            "unknown-v1.2.3",
            "db11-crew-v01.2.3",
            "db11-crew-v1.2",
            "db11-crew-v1.2.3-beta.1",
            "db11-crew-v1.2.3/../../root",
            "pi-copilot-usage-v1.2",
        )
        for tag in invalid_tags:
            with self.subTest(tag=tag), self.assertRaises(RELEASE_IDENTITY.IdentityError):
                RELEASE_IDENTITY.parse_tag(tag)
        for selector in ("dbz-ai-tools-workspace", "dbz-skills", "dbz-crew"):
            with self.subTest(selector=selector), self.assertRaises(
                RELEASE_IDENTITY.IdentityError
            ):
                RELEASE_IDENTITY.resolve_selector(selector, "1.2.3")

    def test_nonmutating_make_identity_check_validates_manifest_version(self) -> None:
        versions: dict[str, str] = {}
        for selector, (workspace, _npm_name) in EXPECTED.items():
            current_version = json.loads(
                (ROOT / workspace / "package.json").read_text(encoding="utf-8")
            )["version"]
            versions[selector] = current_version
            valid = subprocess.run(
                ["make", "release-info", f"PACKAGE={selector}", f"VERSION={current_version}"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(valid.returncode, 0, valid.stderr or valid.stdout)
            self.assertIn(f"workspace: {workspace}", valid.stdout)
            self.assertIn(f"tag: {selector}-v{current_version}", valid.stdout)

        for arguments in (
            ["PACKAGE=unknown", f"VERSION={versions['db11-skills']}"],
            ["PACKAGE=dbz-crew", f"VERSION={versions['db11-skills']}"],
            ["PACKAGE=db11-skills", "VERSION=999.999.999"],
            ["PACKAGE=db11-skills", "VERSION=01.2.3"],
        ):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    ["make", "release-info", *arguments],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0, result.stdout)


class ReleaseConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.ci_workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    def test_changesets_keep_independent_versions_and_no_removed_target(self) -> None:
        config = json.loads((ROOT / ".changeset/config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["fixed"], [])
        self.assertEqual(config["linked"], [])
        self.assertEqual(config["changelog"][1]["repo"], "debonzi/db11-ai-tools")
        for changeset in (ROOT / ".changeset").glob("*.md"):
            if changeset.name == "README.md":
                continue
            self.assertNotIn("@debonzi/dbz-ai-tools", changeset.read_text(encoding="utf-8"))
        crew_changeset = (ROOT / ".changeset/restore-db11-crew.md").read_text(
            encoding="utf-8"
        )
        self.assertIn('"@debonzi/db11-crew": none', crew_changeset)
        crew_changelog = (ROOT / "packages/db11-crew/CHANGELOG.md").read_text(
            encoding="utf-8"
        )
        release_guide = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
        crew_release_surfaces = (crew_changeset, crew_changelog, release_guide)
        for evidence in (
            "`~/.local/state/db11-crew`",
            "marker identity `db11-crew`",
            "`refs/heads/db11-crew/<run-id>`",
            "explicit activation",
            "exact-session reload",
        ):
            with self.subTest(evidence=evidence):
                for surface in crew_release_surfaces:
                    self.assertIn(evidence, surface)
        for obsolete in (
            "db11-crew-v2",
            "cutover-rollback.md",
            "hard cutover",
            "hard-cutover",
            "old-runtime quiescence",
            "generation reassessment",
            "noncanonical residue",
        ):
            with self.subTest(obsolete=obsolete):
                for surface in crew_release_surfaces:
                    self.assertNotIn(obsolete, surface.lower())
        self.assertIn("no production dependencies", release_guide)
        self.assertIn("member companion only for explicit authenticated member loading", release_guide)
        status = subprocess.run(
            ["npx", "changeset", "status", "--output", "changeset-status.tmp.json"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.addCleanup((ROOT / "changeset-status.tmp.json").unlink, missing_ok=True)
        self.assertEqual(status.returncode, 0, status.stderr or status.stdout)
        changeset_status = json.loads(
            (ROOT / "changeset-status.tmp.json").read_text(encoding="utf-8")
        )
        crew_release = next(
            release
            for release in changeset_status["releases"]
            if release["name"] == "@debonzi/db11-crew"
        )
        self.assertEqual(crew_release["type"], "none")
        self.assertEqual(crew_release["oldVersion"], "0.2.0")
        self.assertEqual(crew_release["newVersion"], "0.2.0")
        codex_changelog = (ROOT / "packages/pi-codex-usage/CHANGELOG.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("`/cusage` to `/usage-codex`", codex_changelog)
        copilot_changelog = (ROOT / "packages/pi-copilot-usage/CHANGELOG.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("`/usage-copilot`", copilot_changelog)

    def test_ci_runs_the_supported_local_commands_without_publication(self) -> None:
        commands = re.findall(r"(?m)^\s+- run: (.+)$", self.ci_workflow)
        self.assertEqual(commands, ["npm ci", "npm run check", "npm run pack:check"])
        self.assertIn("permissions:\n  contents: read", self.ci_workflow)
        self.assertIn("cancel-in-progress: true", self.ci_workflow)
        self.assertNotIn("npm publish", self.ci_workflow)

    def test_release_workflow_triggers_only_for_qualified_tags(self) -> None:
        tags = set(re.findall(r'^\s+- "([^"]+-v\*)"$', self.workflow, re.MULTILINE))
        self.assertEqual(tags, {f"{selector}-v*" for selector in EXPECTED})
        self.assertNotRegex(self.workflow, r'tags:\s*\[\s*"v\*"')

    def test_validation_precedes_and_controls_publication(self) -> None:
        validate = self.workflow.index("  validate:")
        publish = self.workflow.index("  publish:")
        validation_block = self.workflow[validate:publish]
        publication_block = self.workflow[publish:]

        for required in (
            "fetch-depth: 0",
            'git cat-file -t "$GITHUB_REF"',
            "scripts/release_identity.py",
            'manifest.name !== process.env.NPM_PACKAGE',
            'manifest.version !== process.env.VERSION',
            'git merge-base --is-ancestor "$tag_commit" origin/main',
            "npm ci",
            "npm run check",
            "npm run pack:check",
        ):
            self.assertIn(required, validation_block)

        validate_commands = re.findall(r"(?m)^      - run: (.+)$", validation_block)
        self.assertEqual(validate_commands[-3:], ["npm ci", "npm run check", "npm run pack:check"])
        self.assertIn("needs: validate", publication_block)
        self.assertIn("scripts/materialize_bundle.py", publication_block)
        self.assertIn("--package db11-crew", publication_block)
        self.assertIn("id-token: write", publication_block)
        self.assertIn("environment:", publication_block)
        self.assertIn("working-directory: ${{ needs.validate.outputs.workspace }}", publication_block)
        self.assertIn("npm publish --access public --provenance", publication_block)
        self.assertIn("cancel-in-progress: false", publication_block)
        self.assertNotRegex(publication_block, r"(?m)^\s+- run: npm publish")

    def test_workflow_permissions_are_read_only_except_publish_oidc(self) -> None:
        prefix = self.workflow[: self.workflow.index("jobs:")]
        self.assertIn("permissions:\n  contents: read", prefix)
        self.assertNotIn("contents: write", self.workflow)
        self.assertNotIn("packages: write", self.workflow)
        validate_block = self.workflow[
            self.workflow.index("  validate:") : self.workflow.index("  publish:")
        ]
        self.assertNotIn("id-token: write", validate_block)

    def test_makefile_never_publishes_and_uses_package_qualified_identity(self) -> None:
        self.assertNotIn("npm publish", self.makefile)
        self.assertNotIn("require(\"./package.json\").version", self.makefile)
        self.assertIn("scripts/release_identity.py", self.makefile)
        self.assertIn("release-info", self.makefile)
        for target in ("release-preflight", "release-check", "release-tag", "release-push"):
            self.assertRegex(self.makefile, rf"(?m)^{re.escape(target)}:")

    def test_root_manifest_is_private_and_not_publishable(self) -> None:
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIs(manifest["private"], True)
        self.assertNotIn("version", manifest)
        self.assertNotIn("pi", manifest)
        self.assertNotIn("publishConfig", manifest)


if __name__ == "__main__":
    unittest.main()
