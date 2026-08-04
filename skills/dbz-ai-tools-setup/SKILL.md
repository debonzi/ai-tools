---
name: dbz-ai-tools-setup
description: Configure which skills and extensions from the DBZ AI Tools Pi package are enabled globally or for the current project. Use only when the user explicitly invokes this setup skill or asks to reconfigure the installed package.
compatibility: Requires Pi 0.83.0 or newer and Python 3. DBZ Workflows additionally requires a supported Git worktree. DBZ Crew additionally requires Git, Herdr, and Pi worker support in Herdr.
disable-model-invocation: true
---

# DBZ AI Tools Setup

Configure the installed Pi package without copying package resources or editing its managed checkout.

Resolve all referenced paths relative to this skill directory. Run the helper from the requester's current working directory:

```bash
python3 <skill-directory>/scripts/configure.py <command>
```

Do not install software, modify Pi trust decisions, or change settings before the user approves the complete plan. Ask one concise setup question per turn.

## Discovery

Run:

```bash
python3 <skill-directory>/scripts/configure.py list
```

Use the returned catalog rather than a hard-coded skill list, so newly delivered skills are offered after package updates.

Ask the user:

1. Whether the selection is global or project-local.
2. Which package skills to enable. `dbz-ai-tools-setup` is always enabled and must not be offered as removable.
3. Whether to enable the optional `codex-usage` extension.

Explain that all package files remain installed. The selection controls which resources Pi loads. Skills added by later package updates remain disabled until setup is run again.

When `dbz-crew` is selected, `dbz-crew-events` is enabled automatically and cannot be selected independently. When `dbz-workflows` is selected, its Pi extension is enabled automatically and cannot be selected independently. The optional DBZ Crew executor inside DBZ Workflows remains unavailable when its cohesive CLI resource is absent.

## DBZ Crew preflight

Only when `dbz-crew` is selected, validate all external prerequisites before planning a mutation:

```bash
command -v pi
command -v python3
command -v git
command -v herdr
herdr agent start --help
herdr integration install --help
herdr integration status
```

Require the Herdr help output to advertise Pi worker and integration support. If the official Pi integration is not current or installed, include this explicit mutation in the final plan:

```bash
herdr integration install pi
```

Do not run it yet.

## Plan

Build repeated `--skill <name>` arguments for the selected skills. Add `--enable-codex-usage` only when selected.

Global example:

```bash
python3 <skill-directory>/scripts/configure.py plan \
  --scope global \
  --skill dbz-crew \
  --skill dbz-issues \
  --enable-codex-usage
```

Project example:

```bash
python3 <skill-directory>/scripts/configure.py plan \
  --scope project \
  --project-root "$PWD" \
  --skill dbz-spec
```

Report the settings path, selected resources, package entry before and after, whether the file changes, and any pending Herdr integration command. Do not expose unrelated settings content.

Ask for one explicit confirmation covering the complete settings and Herdr plan. If planning fails, report the error and make no changes.

## Apply

After confirmation, repeat the exact selection with `apply` and the `before_sha256` returned by `plan`:

```bash
python3 <skill-directory>/scripts/configure.py apply \
  --scope <global-or-project> \
  <selection-arguments> \
  --expected-sha256 <digest>
```

The helper must apply the settings change first. If the digest is stale, stop and plan again instead of bypassing validation.

If DBZ Crew needs its integration, run the previously approved command only after settings are applied:

```bash
herdr integration install pi
herdr integration status
```

Accept only a `pi: current` or legacy `pi: installed` status. If Herdr installation fails, report that settings were already updated and provide the exact retry command; do not roll back unrelated settings.

Finish by reporting the enabled skills and automatically paired extensions. Tell the user that DBZ Workflows still requires separate per-project configuration through `/dbz-workflows-setup`. Tell the user to run `/reload` or restart Pi. Never alter `trust.json` or commit project-local settings unless separately requested.
