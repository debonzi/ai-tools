#!/usr/bin/env python3
"""Resolve approved package release identities without accepting arbitrary paths."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import shlex
import sys


@dataclass(frozen=True)
class PackageIdentity:
    selector: str
    workspace: str
    npm_name: str


PACKAGE_IDENTITIES = {
    "db11-skills": PackageIdentity(
        selector="db11-skills",
        workspace="packages/db11-skills",
        npm_name="@debonzi/db11-skills",
    ),
    "pi-codex-usage": PackageIdentity(
        selector="pi-codex-usage",
        workspace="packages/pi-codex-usage",
        npm_name="@debonzi/pi-codex-usage",
    ),
    "pi-copilot-usage": PackageIdentity(
        selector="pi-copilot-usage",
        workspace="packages/pi-copilot-usage",
        npm_name="@debonzi/pi-copilot-usage",
    ),
}

VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
TAG_PATTERN = re.compile(
    rf"^({'|'.join(re.escape(value) for value in PACKAGE_IDENTITIES)})-v"
    rf"({VERSION_PATTERN.pattern.removeprefix('^').removesuffix('$')})$"
)


class IdentityError(ValueError):
    """The requested release identity is not approved."""


def validate_version(version: str) -> str:
    if not VERSION_PATTERN.fullmatch(version):
        raise IdentityError("VERSION must use an X.Y.Z SemVer number without leading zeroes.")
    return version


def resolve_selector(selector: str, version: str) -> dict[str, str]:
    try:
        identity = PACKAGE_IDENTITIES[selector]
    except KeyError as error:
        allowed = ", ".join(PACKAGE_IDENTITIES)
        raise IdentityError(f"Unknown PACKAGE selector {selector!r}; expected one of: {allowed}.") from error
    validated_version = validate_version(version)
    return {
        **asdict(identity),
        "version": validated_version,
        "tag": f"{selector}-v{validated_version}",
        "package_url": f"https://www.npmjs.com/package/{identity.npm_name}",
    }


def parse_tag(tag: str) -> dict[str, str]:
    match = TAG_PATTERN.fullmatch(tag)
    if match is None:
        allowed = ", ".join(f"{selector}-vX.Y.Z" for selector in PACKAGE_IDENTITIES)
        raise IdentityError(f"Release tag must be one of: {allowed}.")
    selector, version = match.group(1), match.group(2)
    result = resolve_selector(selector, version)
    if result["tag"] != tag:
        raise IdentityError("Release tag is not canonical.")
    return result


def verify_manifest(result: dict[str, str], repository_root: Path) -> None:
    manifest_path = repository_root / result["workspace"] / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IdentityError(f"Could not read selected workspace manifest: {manifest_path}") from error
    if manifest.get("name") != result["npm_name"]:
        raise IdentityError(
            f"Selected workspace name is {manifest.get('name')!r}, expected {result['npm_name']!r}."
        )
    if manifest.get("version") != result["version"]:
        raise IdentityError(
            f"Selected workspace version is {manifest.get('version')!r}, expected {result['version']!r}."
        )


def format_result(result: dict[str, str], output_format: str) -> str:
    if output_format == "json":
        return json.dumps(result, sort_keys=True)
    if output_format == "shell":
        names = {
            "PACKAGE_SELECTOR": "selector",
            "WORKSPACE": "workspace",
            "NPM_PACKAGE": "npm_name",
            "VERSION": "version",
            "TAG": "tag",
            "PACKAGE_URL": "package_url",
        }
        return "\n".join(f"{name}={shlex.quote(result[key])}" for name, key in names.items())
    if output_format == "github-output":
        return "\n".join(
            f"{key}={result[key]}"
            for key in ("selector", "workspace", "npm_name", "version", "tag", "package_url")
        )
    return "\n".join(
        (
            f"selector: {result['selector']}",
            f"workspace: {result['workspace']}",
            f"npm package: {result['npm_name']}",
            f"version: {result['version']}",
            f"tag: {result['tag']}",
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--package", dest="selector")
    source.add_argument("--tag")
    parser.add_argument("--version")
    parser.add_argument(
        "--format",
        choices=("plain", "json", "shell", "github-output"),
        default="plain",
    )
    parser.add_argument(
        "--verify-manifest",
        action="store_true",
        help="verify the selected workspace manifest name and version",
    )
    parser.add_argument("--repository-root", type=Path, default=Path.cwd())
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.tag is not None:
            if args.version is not None:
                raise IdentityError("--version cannot be combined with --tag.")
            result = parse_tag(args.tag)
        else:
            if args.version is None:
                raise IdentityError("--version is required with --package.")
            result = resolve_selector(args.selector, args.version)
        if args.verify_manifest:
            verify_manifest(result, args.repository_root.resolve())
    except IdentityError as error:
        print(f"release identity error: {error}", file=sys.stderr)
        return 2

    print(format_result(result, args.format))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
