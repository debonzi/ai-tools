#!/usr/bin/env python3
"""Materialize fixed, lockfile-verified bundled dependency closures for staging."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from pathlib import PurePosixPath
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCKFILE = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
LOCKED_PACKAGES = LOCKFILE["packages"]
BUNDLES = {
    "db11-crew": {
        "workspace": "packages/db11-crew",
        "npm_name": "@debonzi/db11-crew",
        "dependencies": {},
    }
}


class BundleError(RuntimeError):
    """The requested bundle cannot be materialized safely."""


def verify_regular_tree(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_symlink():
            raise BundleError(f"Bundled dependency contains a symlink: {path}")


def dependency_lock_key(owner_key: str, dependency: str) -> str:
    owner = ROOT / PurePosixPath(owner_key)
    for ancestor in (owner, *owner.parents):
        try:
            relative = ancestor.relative_to(ROOT)
        except ValueError:
            break
        candidate = (relative / "node_modules" / dependency).as_posix()
        if candidate in LOCKED_PACKAGES:
            return candidate
    raise BundleError(f"Could not resolve locked dependency {dependency!r} from {owner_key}.")


def bundled_lock_keys(selector: str) -> tuple[str, ...]:
    try:
        specification = BUNDLES[selector]
    except KeyError as error:
        allowed = ", ".join(BUNDLES)
        raise BundleError(f"Unknown bundle selector {selector!r}; expected: {allowed}.") from error

    pending = [f"node_modules/{name}" for name in specification["dependencies"]]
    selected: set[str] = set()
    while pending:
        lock_key = pending.pop()
        if lock_key in selected:
            continue
        locked = LOCKED_PACKAGES.get(lock_key)
        if not isinstance(locked, dict):
            raise BundleError(f"Root lockfile has no package record for {lock_key}.")
        if not locked.get("integrity") or not locked.get("resolved"):
            raise BundleError(f"Root lockfile has no registry integrity record for {lock_key}.")
        selected.add(lock_key)
        requirements = {
            **locked.get("dependencies", {}),
            **locked.get("optionalDependencies", {}),
        }
        for dependency in requirements:
            try:
                pending.append(dependency_lock_key(lock_key, dependency))
            except BundleError:
                if dependency in locked.get("optionalDependencies", {}):
                    continue
                raise
    return tuple(sorted(selected))


def verify_destination_manifest(selector: str, destination_root: Path) -> None:
    specification = BUNDLES[selector]
    manifest_path = destination_root / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BundleError(f"Could not read destination manifest: {manifest_path}") from error

    if manifest.get("name") != specification["npm_name"]:
        raise BundleError("Destination manifest does not match the selected package identity.")
    if manifest.get("dependencies", {}) != specification["dependencies"]:
        raise BundleError("Destination production dependencies do not match the bundle allowlist.")
    if manifest.get("bundledDependencies", []) != list(specification["dependencies"]):
        raise BundleError("Destination bundledDependencies do not match the bundle allowlist.")


def materialize(selector: str, destination_root: Path) -> None:
    destination_root = destination_root.resolve()
    verify_destination_manifest(selector, destination_root)

    for lock_key in bundled_lock_keys(selector):
        locked = LOCKED_PACKAGES[lock_key]
        source = (ROOT / PurePosixPath(lock_key)).resolve()
        expected_root = (ROOT / "node_modules").resolve()
        if not source.is_relative_to(expected_root) or not source.is_dir():
            raise BundleError(f"Locked dependency is not installed at the approved source: {source}")
        source_manifest = json.loads((source / "package.json").read_text(encoding="utf-8"))
        if source_manifest.get("version") != locked.get("version"):
            raise BundleError(f"Installed dependency version does not match the lockfile: {lock_key}.")
        verify_regular_tree(source)

        destination = destination_root / PurePosixPath(lock_key)
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or not destination.is_dir():
                raise BundleError(f"Bundle destination is not a regular directory: {destination}")
            destination_manifest = json.loads(
                (destination / "package.json").read_text(encoding="utf-8")
            )
            if destination_manifest.get("version") != locked.get("version"):
                raise BundleError(f"Precopied dependency does not match the lockfile: {lock_key}.")
            verify_regular_tree(destination)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, destination)

    bundle_root = destination_root / "node_modules"
    excluded_directory_names = {
        ".changeset",
        ".drafts",
        ".github",
        "__pycache__",
        "test",
        "tests",
    }
    excluded_directories = sorted(
        (
            path
            for path in bundle_root.rglob("*")
            if path.is_dir() and path.name.lower() in excluded_directory_names
        ),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for excluded_directory in excluded_directories:
        if excluded_directory.exists():
            shutil.rmtree(excluded_directory)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, choices=tuple(BUNDLES))
    parser.add_argument("--destination-root", type=Path)
    parser.add_argument("--print-plan", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.print_plan:
            print("\n".join(bundled_lock_keys(args.package)))
        else:
            if args.destination_root is None:
                raise BundleError("--destination-root is required unless --print-plan is used.")
            materialize(args.package, args.destination_root)
    except BundleError as error:
        print(f"bundle error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
