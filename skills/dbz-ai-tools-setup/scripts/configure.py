#!/usr/bin/env python3
"""Plan and apply DBZ AI Tools Pi package resource filters."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any

CANONICAL_SOURCE = "git:github.com/debonzi/dbz-ai-tools"
SETUP_SKILL = "dbz-ai-tools-setup"
CODEX_USAGE_EXTENSION = "agents/pi/extensions/codex-usage/index.ts"
CREW_EVENTS_EXTENSION = "agents/pi/extensions/dbz-crew-events/index.ts"
PACKAGE_ROOT = Path(__file__).resolve().parents[3]


class ConfigurationError(RuntimeError):
    """A safe settings update cannot be planned or applied."""


def parse_skill_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ConfigurationError(f"skill has no YAML frontmatter: {path}")
    try:
        end = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration as exc:
        raise ConfigurationError(f"skill has unterminated YAML frontmatter: {path}") from exc

    values: dict[str, str] = {}
    for line in lines[1:end]:
        key, separator, value = line.partition(":")
        if separator and key.strip() in {"name", "description"}:
            values[key.strip()] = value.strip().strip("\"'")
    if not values.get("name") or not values.get("description"):
        raise ConfigurationError(f"skill is missing name or description: {path}")
    return values


def skill_catalog() -> list[dict[str, str]]:
    skills_root = PACKAGE_ROOT / "skills"
    result: list[dict[str, str]] = []
    for skill_file in sorted(skills_root.rglob("SKILL.md")):
        metadata = parse_skill_frontmatter(skill_file)
        result.append(
            {
                **metadata,
                "path": skill_file.relative_to(PACKAGE_ROOT).as_posix(),
            }
        )
    names = [entry["name"] for entry in result]
    if len(names) != len(set(names)):
        raise ConfigurationError("the package contains duplicate skill names")
    if SETUP_SKILL not in names:
        raise ConfigurationError(f"the package does not contain the required {SETUP_SKILL} skill")
    return result


def extension_catalog() -> list[dict[str, str]]:
    extensions = [
        {
            "name": "codex-usage",
            "description": "Show usage for the active OpenAI Codex account.",
            "path": CODEX_USAGE_EXTENSION,
        },
        {
            "name": "dbz-crew-events",
            "description": "Deliver DBZ Crew completion events to the originating Pi session.",
            "path": CREW_EVENTS_EXTENSION,
        },
    ]
    for extension in extensions:
        if not (PACKAGE_ROOT / extension["path"]).is_file():
            raise ConfigurationError(f"package extension is missing: {extension['path']}")
    return extensions


def settings_path(scope: str, project_root: Path) -> Path:
    if scope == "global":
        configured = os.environ.get("PI_CODING_AGENT_DIR")
        agent_dir = Path(configured).expanduser() if configured else Path.home() / ".pi" / "agent"
        if not agent_dir.is_absolute():
            raise ConfigurationError("PI_CODING_AGENT_DIR must be an absolute path")
        return agent_dir / "settings.json"
    return project_root.resolve() / ".pi" / "settings.json"


def reject_symlink(path: Path, description: str) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode):
        raise ConfigurationError(f"{description} cannot be a symbolic link: {path}")


def validate_destination(path: Path) -> None:
    reject_symlink(path, "settings file")
    reject_symlink(path.parent, "settings directory")
    if path.exists() and not path.is_file():
        raise ConfigurationError(f"settings path is not a regular file: {path}")
    if path.parent.exists() and not path.parent.is_dir():
        raise ConfigurationError(f"settings parent is not a directory: {path.parent}")

    current = path.parent
    while not current.exists():
        parent = current.parent
        if parent == current:
            break
        current = parent
    reject_symlink(current, "existing settings ancestor")
    if current.exists() and not current.is_dir():
        raise ConfigurationError(f"existing settings ancestor is not a directory: {current}")


def read_settings(path: Path) -> tuple[dict[str, Any], bytes]:
    validate_destination(path)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}, b""
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"settings file is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"settings root must be a JSON object: {path}")
    packages = value.get("packages", [])
    if not isinstance(packages, list):
        raise ConfigurationError(f"settings packages must be an array: {path}")
    return value, raw


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def package_source(entry: Any) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict) and isinstance(entry.get("source"), str):
        return entry["source"]
    return None


def normalized_git_source(source: str) -> str:
    value = source.strip().lower()
    if value.startswith("git:") and not value.startswith("git://"):
        value = value[4:]
    for scheme in ("https://", "http://", "ssh://", "git://"):
        if value.startswith(scheme):
            value = value[len(scheme) :]
            break
    if value.startswith("git@"):
        value = value[4:]
    if value.startswith("github.com:"):
        value = "github.com/" + value[len("github.com:") :]
    value = value.rstrip("/")
    value = re.sub(r"\.git(?=@[^/]+$|$)", "", value)
    value = re.sub(r"@[^/]+$", "", value)
    return value


def source_matches(source: str, base_dir: Path) -> bool:
    if normalized_git_source(source) == "github.com/debonzi/dbz-ai-tools":
        return True
    if source.startswith(("/", "./", "../", "~")):
        candidate = Path(source).expanduser()
        if not candidate.is_absolute():
            candidate = base_dir / candidate
        try:
            return candidate.resolve() == PACKAGE_ROOT
        except OSError:
            return False
    return False


def matching_package(settings: dict[str, Any], path: Path) -> tuple[int, Any] | None:
    matches: list[tuple[int, Any]] = []
    for index, entry in enumerate(settings.get("packages", [])):
        source = package_source(entry)
        if source is not None and source_matches(source, path.parent):
            matches.append((index, entry))
    if len(matches) > 1:
        raise ConfigurationError(f"settings contain multiple DBZ AI Tools package entries: {path}")
    return matches[0] if matches else None


def selected_resources(selected_names: list[str], enable_codex_usage: bool) -> tuple[list[str], list[str]]:
    catalog = skill_catalog()
    by_name = {entry["name"]: entry for entry in catalog}
    unknown = sorted(set(selected_names) - set(by_name))
    if unknown:
        raise ConfigurationError(f"unknown skill selection: {', '.join(unknown)}")

    names = set(selected_names)
    names.add(SETUP_SKILL)
    skills = [by_name[name]["path"] for name in sorted(names)]
    extensions: list[str] = []
    if "dbz-crew" in names:
        extensions.append(CREW_EVENTS_EXTENSION)
    if enable_codex_usage:
        extensions.append(CODEX_USAGE_EXTENSION)
    return skills, sorted(extensions)


def full_filter(entry: Any, source: str, skills: list[str], extensions: list[str]) -> dict[str, Any]:
    result = dict(entry) if isinstance(entry, dict) else {"source": source}
    result["source"] = source
    result.pop("autoload", None)
    result["skills"] = skills
    result["extensions"] = extensions
    return result


def delta_filter(entry: Any, source: str, skills: list[str], extensions: list[str]) -> dict[str, Any]:
    result = dict(entry) if isinstance(entry, dict) else {"source": source}
    result["source"] = source
    result["autoload"] = False
    result["skills"] = ["!skills/**", *[f"+{path}" for path in skills]]
    result["extensions"] = [
        "!agents/pi/extensions/**",
        *[f"+{path}" for path in extensions],
    ]
    return result


def build_plan(
    scope: str,
    project_root: Path,
    selected_names: list[str],
    enable_codex_usage: bool,
) -> dict[str, Any]:
    target_path = settings_path(scope, project_root)
    target_settings, target_raw = read_settings(target_path)
    target_match = matching_package(target_settings, target_path)
    skills, extensions = selected_resources(selected_names, enable_codex_usage)

    packages = list(target_settings.get("packages", []))
    previous_entry: Any = None
    mode = "full"

    if target_match:
        index, previous_entry = target_match
        source = package_source(previous_entry)
        assert source is not None
        if isinstance(previous_entry, dict) and previous_entry.get("autoload") is False:
            if scope != "project":
                raise ConfigurationError("autoload: false is valid only for a project package override")
            global_path = settings_path("global", project_root)
            global_settings, _ = read_settings(global_path)
            if not matching_package(global_settings, global_path):
                raise ConfigurationError("project package delta has no matching global package installation")
            mode = "delta"
            replacement = delta_filter(previous_entry, source, skills, extensions)
        else:
            replacement = full_filter(previous_entry, source, skills, extensions)
        packages[index] = replacement
    elif scope == "project":
        global_path = settings_path("global", project_root)
        global_settings, _ = read_settings(global_path)
        global_match = matching_package(global_settings, global_path)
        if not global_match:
            raise ConfigurationError(
                "DBZ AI Tools is not installed globally or in this project; run "
                f"`pi install {CANONICAL_SOURCE}` or `pi install -l {CANONICAL_SOURCE}` first"
            )
        source = package_source(global_match[1])
        assert source is not None
        replacement = delta_filter(None, source, skills, extensions)
        packages.append(replacement)
        mode = "delta"
    else:
        raise ConfigurationError(
            f"DBZ AI Tools is not installed globally; run `pi install {CANONICAL_SOURCE}` first"
        )

    updated = dict(target_settings)
    updated["packages"] = packages
    return {
        "scope": scope,
        "settings_path": str(target_path),
        "before_sha256": digest(target_raw),
        "mode": mode,
        "selected_skills": [entry["name"] for entry in skill_catalog() if entry["path"] in skills],
        "selected_extensions": [entry["name"] for entry in extension_catalog() if entry["path"] in extensions],
        "package_before": previous_entry,
        "package_after": replacement,
        "changed": updated != target_settings,
        "updated_settings": updated,
    }


def write_settings_atomic(path: Path, settings: dict[str, Any], expected_digest: str) -> None:
    validate_destination(path)
    _, current_raw = read_settings(path)
    if digest(current_raw) != expected_digest:
        raise ConfigurationError("settings changed after planning; run the setup plan again")

    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    validate_destination(path)
    existing_mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    payload = (json.dumps(settings, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        validate_destination(path)
        latest = path.read_bytes() if path.exists() else b""
        if digest(latest) != expected_digest:
            raise ConfigurationError("settings changed while applying the plan; no replacement was made")
        os.replace(temporary, path)
        os.chmod(path, existing_mode)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in plan.items() if key != "updated_settings"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Configure DBZ AI Tools Pi package resources")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list", help="List package skills and extensions")
    for command in ("plan", "apply"):
        child = subparsers.add_parser(command, help=f"{command.capitalize()} a package resource selection")
        child.add_argument("--scope", choices=("global", "project"), required=True)
        child.add_argument("--project-root", type=Path, default=Path.cwd())
        child.add_argument("--skill", action="append", default=[])
        child.add_argument("--enable-codex-usage", action="store_true")
        if command == "apply":
            child.add_argument("--expected-sha256", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "list":
            output = {"skills": skill_catalog(), "extensions": extension_catalog()}
        else:
            plan = build_plan(args.scope, args.project_root, args.skill, args.enable_codex_usage)
            if args.command == "apply" and plan["changed"]:
                if plan["before_sha256"] != args.expected_sha256:
                    raise ConfigurationError("the supplied plan digest is stale; run the setup plan again")
                write_settings_atomic(
                    Path(plan["settings_path"]),
                    plan["updated_settings"],
                    args.expected_sha256,
                )
            output = public_plan(plan)
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0
    except (ConfigurationError, OSError) as exc:
        print(json.dumps({"error": "configuration_error", "message": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
