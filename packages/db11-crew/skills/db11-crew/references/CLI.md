# DB11 Crew

DB11 Crew delegates explicitly requested independent tasks from Pi to Pi workers in isolated Git worktrees and Herdr tabs. Workers inherit the active provider, model, and thinking level.

## Requirements

- Pi
- Herdr
- Git
- Python 3

Initially verified with Pi 0.83.0 and Herdr 0.7.5. Package setup and preflight validate required capabilities at runtime instead of relying only on version numbers.

## Installation

Install the published DB11 Crew Pi package:

```bash
pi install npm:@debonzi/db11-crew
```

For development from the repository root, install its local workspace instead:

```bash
pi install ./packages/db11-crew
```

Then explicitly run the setup skill when prerequisite or integration guidance is needed:

```text
/skill:db11-crew-setup
```

The setup skill validates DB11 Crew prerequisites and presents a complete plan before any mutation. It can run `herdr integration install pi` only after separate explicit confirmation. It does not install unrelated software, change trust decisions, or edit package filters. Reload or restart an already running Pi session after setup.

## Commands

Resolve `<db11-crew>` to `python3 <db11-crew-skill-directory>/scripts/db11-crew`:

```bash
# Implementation workers: strict clean-main preflight
<db11-crew> preflight
<db11-crew> dispatch --task-id <id> --prompt '<bounded task>'
<db11-crew> dispatch --task-id <id> --prompt '<bounded task>' --parallel

# Read-only workers: dirty and non-main source worktrees are allowed
<db11-crew> preflight --read-only
<db11-crew> dispatch --read-only --task-id <id> --prompt '<bounded task>'
<db11-crew> preflight --read-only --committed-only [--base <ref>]
<db11-crew> dispatch --read-only --committed-only [--base <ref>] --task-id <id> --prompt '<bounded task>'
<db11-crew> preflight --read-only --in-place
<db11-crew> dispatch --read-only --in-place --task-id <id> --prompt '<bounded task>'

<db11-crew> status
<db11-crew> rebase --task-id <id>
<db11-crew> integrate --branch <worker-branch>
<db11-crew> cleanup --task-id <id> --branch <worker-branch>
```

Pi runtime metadata is normally inherited from `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. Troubleshooting or explicitly requested overrides are available through `--worker-provider`, `--worker-model`, and `--worker-thinking`.

### Read-only modes

`--read-only` creates an isolated worktree from the current `HEAD`, applies tracked local changes, and copies non-ignored untracked files. Ignored files are never copied. Staged and unstaged content is reproduced as visible working-tree content, not as the source index state.

Use `--committed-only` to exclude all local changes. It uses the current `HEAD` unless `--base <ref>` is supplied. `--base` cannot be combined with ordinary read-only snapshots because local changes may not apply safely to another commit.

Use `--in-place` only for explicitly requested live-worktree exploration. The worker sees the exact current repository, including ignored files, without filesystem isolation. DB11 Crew reports concurrent changes as a warning because it cannot attribute them reliably.

Isolated read-only workers are checked against their initial snapshot. Any change fails validation and retains the tab, branch, and worktree for inspection. Unchanged read-only resources are removed automatically after the result is captured. In-place tabs are also closed automatically after result capture.

Workers never merge, push, rebase `main`, or remove implementation worktrees. Implementation rebase, integration, and cleanup require separate explicit user requests and retain the strict clean-`main` preflight.

## State and completion

State is always stored in `~/.local/state/db11-crew`; `DB11_CREW_STATE_DIR` and `XDG_STATE_HOME` do not change this location. Prompts, results, and completion events are private local state and must not be committed.

Completion events are delivered only to the original Pi session and use follow-up delivery, so they do not steer an active principal turn. Read-only result files and events remain available after automatic resource cleanup.

## Validation

From the `packages/db11-crew` workspace in a full repository source checkout:

```bash
python3 -m unittest discover -s skills/db11-crew/tests -v
TZ=UTC node --test agents/pi/extensions/db11-crew-events/index.test.ts
```

These deterministic tests do not require live Herdr access. The explicit setup workflow is also covered by the repository's [package structure suite](https://github.com/debonzi/db11-ai-tools/blob/main/tests/test_package.py).

The [manual Pi smoke test](https://github.com/debonzi/db11-ai-tools/blob/main/packages/db11-crew/tests/SMOKE_DB11_CREW.md) is repository-only.
