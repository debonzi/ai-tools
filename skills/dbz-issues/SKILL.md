---
name: dbz-issues
description: Manage local Markdown issue registries for AI agents, including explicit initialization and issue creation, read-only listing and inspection, dependency-aware readiness, editing, DBZ Workflows linkage, and terminal closure. Use when the requester asks to create, inspect, organize, update, prioritize, or close file-based issues; do not use for remote GitHub or GitLab issues.
---

# DBZ Issues

Use the bundled `scripts/issues.py` CLI for every registry operation. Resolve paths relative to this skill directory, but run the CLI from the requester's repository so the default root resolves to `<git-root>/issues`.

## Safety contract

- Run `init`, `create`, `edit`, or `close` only after an explicit user request for that mutation.
- Never turn findings, suggestions, TODOs, or audit results into issues automatically.
- `list`, `show`, and `ready` are read-only and may be used to answer issue-registry questions.
- Never edit issue Markdown files manually when the CLI can perform the operation.
- Write issue titles and descriptions in English.
- Never reopen, delete, force-close, link, unlink, or otherwise modify a closed issue. Open a new issue when follow-up work is needed.
- Use `link-workflow` and `unlink-workflow` only through a confirmed DBZ Workflows adapter operation; ordinary issue management must not create workflow links directly.
- Never commit issue changes unless the user separately requests a commit.
- Do not use this skill for GitHub, GitLab, or other remote issue systems.

## Root selection

Every command accepts an optional registry root before the subcommand:

```bash
python3 <skill-directory>/scripts/issues.py --root <workspace>/<path>/issues <command>
```

When `--root` is omitted, the CLI uses `<git-root>/issues`. Initialize a registry only when explicitly requested:

```bash
python3 <skill-directory>/scripts/issues.py --root <path-to-issues> init
```

Initialization creates `open/` only. The CLI creates `closed/` when the first issue is closed.

## Read-only operations

```bash
python3 <skill-directory>/scripts/issues.py [--root <path>] list --status open
python3 <skill-directory>/scripts/issues.py [--root <path>] list --status closed
python3 <skill-directory>/scripts/issues.py [--root <path>] list --status all
python3 <skill-directory>/scripts/issues.py [--root <path>] show <id-or-basename>
python3 <skill-directory>/scripts/issues.py [--root <path>] ready
```

`ready` returns open issues whose dependencies are all closed.

## Mutating operations

Create an issue:

```bash
python3 <skill-directory>/scripts/issues.py [--root <path>] create \
  --title '<English title>' \
  --description '<English description>' \
  --depends-on <dependency-basename> ...
```

Omit `--depends-on` when there are no dependencies.

Edit an open issue. The filename, creation date, and status remain unchanged:

```bash
python3 <skill-directory>/scripts/issues.py [--root <path>] edit <id-or-basename> \
  --title '<new title>' \
  --description '<new description>' \
  --depends-on <replacement dependencies> ...
```

Pass `--depends-on` with no values to clear dependencies. Omit fields that should remain unchanged.

DBZ Workflows uses the supported adapter-only linkage commands to maintain the issue side of a bidirectional relationship:

```bash
python3 <skill-directory>/scripts/issues.py [--root <path>] link-workflow <issue-id> \
  --workflow-id WF-0001 --relation resolves
python3 <skill-directory>/scripts/issues.py [--root <path>] unlink-workflow <issue-id> \
  --workflow-id WF-0001 --relation resolves
```

Relations are `resolves`, `partially-addresses`, and `related`. Do not invoke these commands outside a confirmed DBZ Workflows adapter operation.

Close an issue only after all dependencies are closed:

```bash
python3 <skill-directory>/scripts/issues.py [--root <path>] close <id-or-basename>
```

Closing is terminal. The CLI moves the issue to `closed/`, sets `status: closed`, and records the UTC closing date.

## Results

The CLI emits JSON. On success, report the affected issue ID, relative path, status, and dependencies. On failure, report the returned error code and message without bypassing validation or editing files manually.
