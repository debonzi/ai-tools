# DBZ Crew

DBZ Crew delegates explicitly requested independent tasks from Pi to Pi workers in isolated Git worktrees and Herdr tabs. Workers inherit the active provider, model, and thinking level.

## Requirements

- Pi
- Herdr
- Git
- Python 3

Initially verified with Pi 0.83.0 and Herdr 0.7.5. Package setup and preflight validate required capabilities at runtime instead of relying only on version numbers.

## Installation

Install the DBZ AI Tools Pi package and run its explicit setup skill:

```bash
pi install git:github.com/debonzi/dbz-ai-tools
```

```text
/skill:dbz-ai-tools-setup
```

When DBZ Crew is selected, setup validates its prerequisites and can run `herdr integration install pi` after explicit confirmation. Reload or restart an already running Pi session after setup.

## Commands

Resolve `<dbz-crew>` to `python3 <dbz-crew-skill-directory>/scripts/dbz-crew`:

```bash
# Implementation workers: strict clean-main preflight
<dbz-crew> preflight
<dbz-crew> dispatch --task-id <id> --prompt '<bounded task>'
<dbz-crew> dispatch --task-id <id> --prompt '<bounded task>' --parallel

# Read-only workers: dirty and non-main source worktrees are allowed
<dbz-crew> preflight --read-only
<dbz-crew> dispatch --read-only --task-id <id> --prompt '<bounded task>'
<dbz-crew> preflight --read-only --committed-only [--base <ref>]
<dbz-crew> dispatch --read-only --committed-only [--base <ref>] --task-id <id> --prompt '<bounded task>'
<dbz-crew> preflight --read-only --in-place
<dbz-crew> dispatch --read-only --in-place --task-id <id> --prompt '<bounded task>'

<dbz-crew> status
<dbz-crew> rebase --task-id <id>
<dbz-crew> integrate --branch <worker-branch>
<dbz-crew> cleanup --task-id <id> --branch <worker-branch>
```

Pi runtime metadata is normally inherited from `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. Troubleshooting or explicitly requested overrides are available through `--worker-provider`, `--worker-model`, and `--worker-thinking`.

### Read-only modes

`--read-only` creates an isolated worktree from the current `HEAD`, applies tracked local changes, and copies non-ignored untracked files. Ignored files are never copied. Staged and unstaged content is reproduced as visible working-tree content, not as the source index state.

Use `--committed-only` to exclude all local changes. It uses the current `HEAD` unless `--base <ref>` is supplied. `--base` cannot be combined with ordinary read-only snapshots because local changes may not apply safely to another commit.

Use `--in-place` only for explicitly requested live-worktree exploration. The worker sees the exact current repository, including ignored files, without filesystem isolation. DBZ Crew reports concurrent changes as a warning because it cannot attribute them reliably.

Isolated read-only workers are checked against their initial snapshot. Any change fails validation and retains the tab, branch, and worktree for inspection. Unchanged read-only resources are removed automatically after the result is captured. In-place tabs are also closed automatically after result capture.

Workers never merge, push, rebase `main`, or remove implementation worktrees. Implementation rebase, integration, and cleanup require separate explicit user requests and retain the strict clean-`main` preflight.

## State and completion

State is always stored in `~/.local/state/dbz-crew`; `DBZ_CREW_STATE_DIR` and `XDG_STATE_HOME` do not change this location. Prompts, results, and completion events are private local state and must not be committed.

Completion events are delivered only to the original Pi session and use follow-up delivery, so they do not steer an active principal turn. Read-only result files and events remain available after automatic resource cleanup.

## Validation

```bash
python3 -m unittest discover -s skills/dbz-crew/tests -v
TZ=UTC node --test agents/pi/extensions/dbz-crew-events/index.test.ts
tests/test-install.sh
```

See the package setup tests in `skills/dbz-ai-tools-setup/tests/`.

The manual Pi checklist is in [`tests/SMOKE_DBZ_CREW.md`](../../../tests/SMOKE_DBZ_CREW.md).
