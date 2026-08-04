#!/usr/bin/env python3
"""Manage a local Markdown issue registry without third-party dependencies."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata
import uuid
from typing import Any, Iterable, NoReturn


ISSUE_FILE_RE = re.compile(r"^(?P<number>[0-9]{3,})-(?P<slug>[a-z0-9]+(?:-[a-z0-9]+)*)\.md$")
DEPENDENCY_RE = re.compile(r"^[0-9]{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
STATUSES = {"open", "closed"}
WORKFLOW_ID_RE = re.compile(r"^WF-[0-9]{4,}$")
WORKFLOW_RELATIONS = {"resolves", "partially-addresses", "related"}


class IssueError(RuntimeError):
    """Expected failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise IssueError("usage_error", message)


@dataclass(frozen=True)
class WorkflowLink:
    workflow_id: str
    relation: str


@dataclass(frozen=True)
class Issue:
    path: Path
    identifier: str
    number: int
    created: str
    status: str
    title: str
    dependencies: tuple[str, ...]
    description: str
    closed: str | None = None
    workflows: tuple[WorkflowLink, ...] = ()


def utc_date() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def emit(payload: dict[str, Any], *, stream: Any = sys.stdout) -> None:
    json.dump(payload, stream, indent=2, sort_keys=True, ensure_ascii=False)
    stream.write("\n")


def fail(code: str, message: str) -> NoReturn:
    raise IssueError(code, message)


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.path.expanduser(str(path))))


def existing_components(path: Path) -> Iterable[Path]:
    absolute = lexical_absolute(path)
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if os.path.lexists(current):
            yield current
        else:
            return


def reject_symlink_components(path: Path) -> None:
    for component in existing_components(path):
        try:
            metadata = component.lstat()
        except OSError as exc:
            fail("unsafe_path", f"unable to inspect path component {component}: {exc}")
        if stat.S_ISLNK(metadata.st_mode):
            fail("unsafe_path", f"symlinked registry path is not allowed: {component}")


def require_real_directory(path: Path, label: str) -> None:
    if not os.path.lexists(path):
        fail("registry_not_found", f"{label} does not exist: {path}")
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail("filesystem_error", f"unable to inspect {path}: {exc}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        fail("unsafe_path", f"{label} must be a real directory: {path}")


def git_root(cwd: Path) -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        fail("git_root_unavailable", "current directory is not inside a Git repository; pass --root")
    return lexical_absolute(Path(result.stdout.strip()))


def resolve_root(configured: str | None, cwd: Path | None = None) -> Path:
    current = cwd or Path.cwd()
    root = Path(configured) if configured else git_root(current) / "issues"
    return lexical_absolute(root if root.is_absolute() else current / root)


def validate_registry(root: Path, *, require_open: bool = True) -> None:
    reject_symlink_components(root)
    require_real_directory(root, "issue registry")
    open_directory = root / "open"
    if require_open:
        require_real_directory(open_directory, "open issue directory")
    closed_directory = root / "closed"
    if os.path.lexists(closed_directory):
        require_real_directory(closed_directory, "closed issue directory")


def initialize_registry(root: Path) -> bool:
    reject_symlink_components(root)
    created = not os.path.lexists(root)
    if os.path.lexists(root):
        require_real_directory(root, "issue registry")
    else:
        try:
            root.mkdir(parents=True)
        except OSError as exc:
            fail("filesystem_error", f"unable to create issue registry {root}: {exc}")
        reject_symlink_components(root)
    open_directory = root / "open"
    if os.path.lexists(open_directory):
        require_real_directory(open_directory, "open issue directory")
    else:
        try:
            open_directory.mkdir()
        except OSError as exc:
            fail("filesystem_error", f"unable to create open issue directory {open_directory}: {exc}")
        created = True
    closed_directory = root / "closed"
    if os.path.lexists(closed_directory):
        require_real_directory(closed_directory, "closed issue directory")
    return created


def parse_quoted(value: str, path: Path, field: str) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        fail("invalid_issue", f"{path}: {field} must be a double-quoted string: {exc}")
    if not isinstance(parsed, str) or not parsed.strip():
        fail("invalid_issue", f"{path}: {field} must be a non-empty string")
    return parsed


def validate_date(value: str, path: Path, field: str) -> str:
    if not DATE_RE.fullmatch(value):
        fail("invalid_issue", f"{path}: {field} must use YYYY-MM-DD")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        fail("invalid_issue", f"{path}: {field} is not a valid date")
    return value


def parse_issue(path: Path, expected_status: str) -> Issue:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail("filesystem_error", f"unable to inspect issue {path}: {exc}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        fail("unsafe_path", f"issue must be a real regular file: {path}")
    match = ISSUE_FILE_RE.fullmatch(path.name)
    if not match:
        fail("invalid_issue", f"invalid issue filename: {path.name}")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        fail("filesystem_error", f"unable to read issue {path}: {exc}")
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        fail("invalid_issue", f"{path}: missing opening frontmatter delimiter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail("invalid_issue", f"{path}: missing closing frontmatter delimiter")

    fields: dict[str, Any] = {}
    index = 1
    while index < end:
        line = lines[index]
        if not line or line.startswith((" ", "\t")):
            fail("invalid_issue", f"{path}: malformed frontmatter line {index + 1}")
        if ":" not in line:
            fail("invalid_issue", f"{path}: malformed frontmatter line {index + 1}")
        key, raw = line.split(":", 1)
        raw = raw.strip()
        if key in fields:
            fail("invalid_issue", f"{path}: duplicate frontmatter field {key}")
        if key == "dependencies":
            dependencies: list[str] = []
            if raw == "[]":
                fields[key] = dependencies
                index += 1
                continue
            if raw:
                fail("invalid_issue", f"{path}: dependencies must be [] or a YAML list")
            index += 1
            while index < end and lines[index].startswith("  - "):
                dependency = parse_quoted(lines[index][4:].strip(), path, "dependency")
                dependencies.append(dependency)
                index += 1
            if not dependencies:
                fail("invalid_issue", f"{path}: empty dependencies must use []")
            fields[key] = dependencies
            continue
        if key == "workflows":
            workflows: list[WorkflowLink] = []
            if raw == "[]":
                fields[key] = workflows
                index += 1
                continue
            if raw:
                fail("invalid_issue", f"{path}: workflows must be [] or a YAML list")
            index += 1
            while index < end and lines[index].startswith("  - id: "):
                workflow_id = parse_quoted(lines[index][8:].strip(), path, "workflow id")
                index += 1
                if index >= end or not lines[index].startswith("    relation: "):
                    fail("invalid_issue", f"{path}: workflow {workflow_id} is missing its relation")
                relation = lines[index][14:].strip()
                workflows.append(WorkflowLink(workflow_id=workflow_id, relation=relation))
                index += 1
            if not workflows:
                fail("invalid_issue", f"{path}: empty workflows must use []")
            fields[key] = workflows
            continue
        if key not in {"created", "status", "title", "closed"}:
            fail("invalid_issue", f"{path}: unsupported frontmatter field {key}")
        fields[key] = parse_quoted(raw, path, key) if key == "title" else raw
        index += 1

    required = {"created", "status", "title", "dependencies"}
    missing = sorted(required - fields.keys())
    if missing:
        fail("invalid_issue", f"{path}: missing frontmatter fields: {', '.join(missing)}")
    status_value = fields["status"]
    if status_value not in STATUSES or status_value != expected_status:
        fail("invalid_issue", f"{path}: status must be {expected_status}")
    created = validate_date(fields["created"], path, "created")
    closed = fields.get("closed")
    if expected_status == "closed":
        if not isinstance(closed, str):
            fail("invalid_issue", f"{path}: closed issue is missing closed date")
        closed = validate_date(closed, path, "closed")
    elif closed is not None:
        fail("invalid_issue", f"{path}: open issue cannot have a closed date")

    body = lines[end + 1 :]
    while body and not body[0].strip():
        body.pop(0)
    if not body or body[0] != "## Description":
        fail("invalid_issue", f"{path}: missing ## Description section")
    description = "\n".join(body[1:]).strip()
    if not description:
        fail("invalid_issue", f"{path}: description must not be empty")
    dependencies = tuple(fields["dependencies"])
    for dependency in dependencies:
        if not DEPENDENCY_RE.fullmatch(dependency):
            fail("invalid_issue", f"{path}: invalid dependency identifier {dependency!r}")
    workflows = tuple(fields.get("workflows", ()))
    seen_workflows: set[str] = set()
    for link in workflows:
        if not WORKFLOW_ID_RE.fullmatch(link.workflow_id):
            fail("invalid_issue", f"{path}: invalid workflow identifier {link.workflow_id!r}")
        if link.relation not in WORKFLOW_RELATIONS:
            fail("invalid_issue", f"{path}: invalid workflow relation {link.relation!r}")
        if link.workflow_id in seen_workflows:
            fail("invalid_issue", f"{path}: duplicate workflow link {link.workflow_id}")
        seen_workflows.add(link.workflow_id)

    return Issue(
        path=path,
        identifier=path.stem,
        number=int(match.group("number")),
        created=created,
        status=status_value,
        title=fields["title"],
        dependencies=dependencies,
        description=description,
        closed=closed,
        workflows=workflows,
    )


def issue_directories(root: Path) -> list[tuple[Path, str]]:
    directories = [(root / "open", "open")]
    closed = root / "closed"
    if os.path.lexists(closed):
        directories.append((closed, "closed"))
    return directories


def find_issue_files(directory: Path) -> list[Path]:
    try:
        children = sorted(os.scandir(directory), key=lambda entry: os.fsencode(entry.name))
    except OSError as exc:
        fail("filesystem_error", f"unable to enumerate {directory}: {exc}")
    paths: list[Path] = []
    for child in children:
        if child.name.endswith(".md"):
            paths.append(Path(child.path))
    return paths


def validate_graph(issues: dict[str, Issue]) -> None:
    numbers: dict[int, str] = {}
    for identifier, issue in issues.items():
        previous = numbers.get(issue.number)
        if previous is not None:
            fail("duplicate_number", f"issues {previous} and {identifier} use number {issue.number:03d}")
        numbers[issue.number] = identifier
        seen: set[str] = set()
        for dependency in issue.dependencies:
            if dependency == identifier:
                fail("self_dependency", f"issue {identifier} cannot depend on itself")
            if dependency in seen:
                fail("duplicate_dependency", f"issue {identifier} repeats dependency {dependency}")
            if dependency not in issues:
                fail("missing_dependency", f"issue {identifier} references missing dependency {dependency}")
            seen.add(dependency)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(identifier: str, trail: list[str]) -> None:
        if identifier in visiting:
            start = trail.index(identifier)
            cycle = trail[start:] + [identifier]
            fail("dependency_cycle", "dependency cycle: " + " -> ".join(cycle))
        if identifier in visited:
            return
        visiting.add(identifier)
        trail.append(identifier)
        for dependency in issues[identifier].dependencies:
            visit(dependency, trail)
        trail.pop()
        visiting.remove(identifier)
        visited.add(identifier)

    for identifier in sorted(issues):
        visit(identifier, [])


def load_registry(root: Path) -> dict[str, Issue]:
    validate_registry(root)
    issues: dict[str, Issue] = {}
    for directory, expected_status in issue_directories(root):
        for path in find_issue_files(directory):
            issue = parse_issue(path, expected_status)
            if issue.identifier in issues:
                fail("duplicate_issue", f"duplicate issue identifier: {issue.identifier}")
            issues[issue.identifier] = issue
    validate_graph(issues)
    return issues


def issue_payload(issue: Issue, root: Path) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": issue.identifier,
        "number": f"{issue.number:03d}",
        "title": issue.title,
        "status": issue.status,
        "created": issue.created,
        "dependencies": list(issue.dependencies),
        "description": issue.description,
        "path": str(issue.path.relative_to(root)),
        "workflows": [
            {"id": link.workflow_id, "relation": link.relation}
            for link in issue.workflows
        ],
    }
    if issue.closed is not None:
        payload["closed"] = issue.closed
    return payload


def render_issue(issue: Issue) -> str:
    lines = [
        "---",
        f"created: {issue.created}",
        f"status: {issue.status}",
        f"title: {json_string(issue.title)}",
    ]
    if issue.dependencies:
        lines.append("dependencies:")
        lines.extend(f"  - {json_string(dependency)}" for dependency in issue.dependencies)
    else:
        lines.append("dependencies: []")
    if issue.workflows:
        lines.append("workflows:")
        for link in issue.workflows:
            lines.append(f"  - id: {json_string(link.workflow_id)}")
            lines.append(f"    relation: {link.relation}")
    if issue.closed is not None:
        lines.append(f"closed: {issue.closed}")
    lines.extend(["---", "", "## Description", "", issue.description.strip(), ""])
    return "\n".join(lines)


def slugify(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    if not slug:
        fail("invalid_title", "title must contain at least one ASCII letter or number")
    return slug[:80].rstrip("-")


def exclusive_write(path: Path, content: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        raise
    except OSError as exc:
        if descriptor is not None:
            os.close(descriptor)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        fail("filesystem_error", f"unable to create {path}: {exc}")


def atomic_publish(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        exclusive_write(temporary, content)
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            raise
        except OSError as exc:
            fail("filesystem_error", f"unable to publish {path}: {exc}")
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def reserve_number(directory: Path, number: int) -> Path:
    reservation = directory / f".{number:03d}.dbz-issues-reservation"
    try:
        exclusive_write(reservation, f"pid={os.getpid()}\n")
    except FileExistsError:
        raise
    return reservation


def atomic_replace(path: Path, content: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail("filesystem_error", f"unable to inspect {path}: {exc}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        fail("unsafe_path", f"refusing to replace non-regular issue file: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, flags, stat.S_IMODE(metadata.st_mode))
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        if descriptor is not None:
            os.close(descriptor)
        fail("filesystem_error", f"unable to replace {path}: {exc}")
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def resolve_issue(issues: dict[str, Issue], value: str) -> Issue:
    requested = value[:-3] if value.endswith(".md") else value
    exact = issues.get(requested)
    if exact is not None:
        return exact
    if requested.isdigit():
        number = int(requested)
        matches = [issue for issue in issues.values() if issue.number == number]
        if len(matches) == 1:
            return matches[0]
    fail("issue_not_found", f"unknown issue: {value}")


def normalized_dependencies(values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    return tuple(value[:-3] if value.endswith(".md") else value for value in values)


def create_issue(root: Path, title: str, description: str, dependencies: list[str]) -> Issue:
    title = title.strip()
    description = description.strip()
    if not title:
        fail("invalid_title", "title must not be empty")
    if not description:
        fail("invalid_description", "description must not be empty")
    issues = load_registry(root)
    normalized = normalized_dependencies(dependencies)
    provisional = Issue(
        path=root / "open" / "placeholder.md",
        identifier="placeholder",
        number=0,
        created=utc_date(),
        status="open",
        title=title,
        dependencies=normalized,
        description=description,
    )
    for dependency in normalized:
        if dependency not in issues:
            fail("missing_dependency", f"new issue references missing dependency {dependency}")
    if len(set(normalized)) != len(normalized):
        fail("duplicate_dependency", "new issue repeats a dependency")

    number = max((issue.number for issue in issues.values()), default=0) + 1
    slug = slugify(title)
    open_directory = root / "open"
    while True:
        try:
            reservation = reserve_number(open_directory, number)
        except FileExistsError:
            number += 1
            continue
        try:
            current_issues = load_registry(root)
            if any(issue.number == number for issue in current_issues.values()):
                number += 1
                continue
            identifier = f"{number:03d}-{slug}"
            path = open_directory / f"{identifier}.md"
            issue = replace(provisional, path=path, identifier=identifier, number=number)
            try:
                atomic_publish(path, render_issue(issue))
            except FileExistsError:
                number += 1
                continue
            return issue
        finally:
            try:
                reservation.unlink(missing_ok=True)
            except OSError:
                pass


def edit_issue(
    root: Path,
    identifier: str,
    title: str | None,
    description: str | None,
    dependencies: list[str] | None,
) -> Issue:
    issues = load_registry(root)
    current = resolve_issue(issues, identifier)
    if current.status != "open":
        fail("closed_issue_immutable", f"closed issue cannot be edited: {current.identifier}")
    if title is None and description is None and dependencies is None:
        fail("no_changes", "edit requires --title, --description, or --depends-on")
    next_title = current.title if title is None else title.strip()
    next_description = current.description if description is None else description.strip()
    if not next_title:
        fail("invalid_title", "title must not be empty")
    if not next_description:
        fail("invalid_description", "description must not be empty")
    next_dependencies = current.dependencies if dependencies is None else normalized_dependencies(dependencies)
    updated = replace(
        current,
        title=next_title,
        description=next_description,
        dependencies=next_dependencies,
    )
    proposed = dict(issues)
    proposed[current.identifier] = updated
    validate_graph(proposed)
    atomic_replace(current.path, render_issue(updated))
    return updated


def link_issue_workflow(
    root: Path,
    identifier: str,
    workflow_id: str,
    relation: str,
) -> tuple[Issue, bool]:
    if not WORKFLOW_ID_RE.fullmatch(workflow_id):
        fail("invalid_workflow_id", "workflow id must use WF- followed by a zero-padded number")
    if relation not in WORKFLOW_RELATIONS:
        fail("invalid_workflow_relation", f"unsupported workflow relation: {relation}")
    issues = load_registry(root)
    current = resolve_issue(issues, identifier)
    if current.status != "open":
        fail("closed_issue_immutable", f"closed issue cannot be linked: {current.identifier}")
    existing = next((link for link in current.workflows if link.workflow_id == workflow_id), None)
    if existing is not None and existing.relation == relation:
        return current, False
    workflows = tuple(
        link for link in current.workflows if link.workflow_id != workflow_id
    ) + (WorkflowLink(workflow_id=workflow_id, relation=relation),)
    updated = replace(current, workflows=tuple(sorted(workflows, key=lambda link: link.workflow_id)))
    atomic_replace(current.path, render_issue(updated))
    return updated, True


def unlink_issue_workflow(
    root: Path,
    identifier: str,
    workflow_id: str,
    relation: str,
) -> tuple[Issue, bool]:
    if not WORKFLOW_ID_RE.fullmatch(workflow_id):
        fail("invalid_workflow_id", "workflow id must use WF- followed by a zero-padded number")
    if relation not in WORKFLOW_RELATIONS:
        fail("invalid_workflow_relation", f"unsupported workflow relation: {relation}")
    issues = load_registry(root)
    current = resolve_issue(issues, identifier)
    if current.status != "open":
        fail("closed_issue_immutable", f"closed issue cannot be unlinked: {current.identifier}")
    matching = next(
        (
            link for link in current.workflows
            if link.workflow_id == workflow_id and link.relation == relation
        ),
        None,
    )
    if matching is None:
        return current, False
    updated = replace(
        current,
        workflows=tuple(link for link in current.workflows if link != matching),
    )
    atomic_replace(current.path, render_issue(updated))
    return updated, True


def ensure_closed_directory(root: Path) -> Path:
    directory = root / "closed"
    if os.path.lexists(directory):
        require_real_directory(directory, "closed issue directory")
        return directory
    try:
        directory.mkdir()
    except OSError as exc:
        fail("filesystem_error", f"unable to create closed issue directory {directory}: {exc}")
    return directory


def close_issue(root: Path, identifier: str) -> Issue:
    issues = load_registry(root)
    current = resolve_issue(issues, identifier)
    if current.status != "open":
        fail("already_closed", f"issue is already closed: {current.identifier}")
    open_dependencies = [
        dependency for dependency in current.dependencies if issues[dependency].status == "open"
    ]
    if open_dependencies:
        fail(
            "open_dependencies",
            f"issue {current.identifier} has open dependencies: {', '.join(open_dependencies)}",
        )
    closed_directory = ensure_closed_directory(root)
    destination = closed_directory / current.path.name
    updated = replace(current, path=destination, status="closed", closed=utc_date())
    try:
        atomic_publish(destination, render_issue(updated))
    except FileExistsError:
        fail("destination_exists", f"refusing to overwrite closed issue: {destination}")
    try:
        current.path.unlink()
    except OSError as exc:
        try:
            destination.unlink(missing_ok=True)
        except OSError:
            pass
        fail("filesystem_error", f"unable to remove open issue after closing: {exc}")
    return updated


def ready_issues(issues: dict[str, Issue]) -> list[Issue]:
    return sorted(
        (
            issue
            for issue in issues.values()
            if issue.status == "open"
            and all(issues[dependency].status == "closed" for dependency in issue.dependencies)
        ),
        key=lambda issue: issue.number,
    )


def build_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(description="Manage a local Markdown issue registry")
    parser.add_argument("--root", help="Path to the issues registry; defaults to <git-root>/issues")
    subparsers = parser.add_subparsers(dest="command", required=True, parser_class=JsonArgumentParser)

    subparsers.add_parser("init")

    create = subparsers.add_parser("create")
    create.add_argument("--title", required=True)
    create.add_argument("--description", required=True)
    create.add_argument("--depends-on", nargs="*", default=[])

    listing = subparsers.add_parser("list")
    listing.add_argument("--status", choices=("open", "closed", "all"), default="open")

    show = subparsers.add_parser("show")
    show.add_argument("issue")

    edit = subparsers.add_parser("edit")
    edit.add_argument("issue")
    edit.add_argument("--title")
    edit.add_argument("--description")
    edit.add_argument("--depends-on", nargs="*")

    link = subparsers.add_parser("link-workflow")
    link.add_argument("issue")
    link.add_argument("--workflow-id", required=True)
    link.add_argument("--relation", choices=tuple(sorted(WORKFLOW_RELATIONS)), required=True)

    unlink_workflow = subparsers.add_parser("unlink-workflow")
    unlink_workflow.add_argument("issue")
    unlink_workflow.add_argument("--workflow-id", required=True)
    unlink_workflow.add_argument("--relation", choices=tuple(sorted(WORKFLOW_RELATIONS)), required=True)

    close = subparsers.add_parser("close")
    close.add_argument("issue")

    subparsers.add_parser("ready")
    return parser


def execute(args: argparse.Namespace) -> dict[str, Any]:
    root = resolve_root(args.root)
    if args.command == "init":
        created = initialize_registry(root)
        return {"ok": True, "command": "init", "root": str(root), "created": created}

    if args.command == "create":
        issue = create_issue(root, args.title, args.description, args.depends_on)
        return {
            "ok": True,
            "command": "create",
            "root": str(root),
            "issue": issue_payload(issue, root),
        }

    issues = load_registry(root)
    if args.command == "list":
        selected = sorted(
            (
                issue
                for issue in issues.values()
                if args.status == "all" or issue.status == args.status
            ),
            key=lambda issue: issue.number,
        )
        return {
            "ok": True,
            "command": "list",
            "root": str(root),
            "status": args.status,
            "issues": [issue_payload(issue, root) for issue in selected],
        }
    if args.command == "show":
        issue = resolve_issue(issues, args.issue)
        return {
            "ok": True,
            "command": "show",
            "root": str(root),
            "issue": issue_payload(issue, root),
        }
    if args.command == "edit":
        issue = edit_issue(root, args.issue, args.title, args.description, args.depends_on)
        return {
            "ok": True,
            "command": "edit",
            "root": str(root),
            "issue": issue_payload(issue, root),
        }
    if args.command == "link-workflow":
        issue, changed = link_issue_workflow(
            root,
            args.issue,
            args.workflow_id,
            args.relation,
        )
        return {
            "ok": True,
            "command": "link-workflow",
            "root": str(root),
            "changed": changed,
            "issue": issue_payload(issue, root),
        }
    if args.command == "unlink-workflow":
        issue, changed = unlink_issue_workflow(
            root,
            args.issue,
            args.workflow_id,
            args.relation,
        )
        return {
            "ok": True,
            "command": "unlink-workflow",
            "root": str(root),
            "changed": changed,
            "issue": issue_payload(issue, root),
        }
    if args.command == "close":
        issue = close_issue(root, args.issue)
        return {
            "ok": True,
            "command": "close",
            "root": str(root),
            "issue": issue_payload(issue, root),
        }
    if args.command == "ready":
        selected = ready_issues(issues)
        return {
            "ok": True,
            "command": "ready",
            "root": str(root),
            "issues": [issue_payload(issue, root) for issue in selected],
        }
    fail("usage_error", f"unsupported command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        emit(execute(args))
        return 0
    except IssueError as exc:
        emit(
            {"ok": False, "error": {"code": exc.code, "message": str(exc)}},
            stream=sys.stderr,
        )
        return 1
    except OSError as exc:
        emit(
            {
                "ok": False,
                "error": {"code": "filesystem_error", "message": str(exc)},
            },
            stream=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        emit(
            {"ok": False, "error": {"code": "interrupted", "message": "operation interrupted"}},
            stream=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
