# DBZ Crew

DBZ Crew delegates explicitly requested independent tasks to Pi or Codex workers in isolated Git worktrees and Herdr tabs. A worker always uses the same agent kind as its principal. Pi workers also inherit the active provider, model, and thinking level.

## Requirements

- Pi or Codex
- Herdr
- Git
- Python 3

Initially verified with Pi 0.83.0 and Herdr 0.7.5. The installer and preflight validate required capabilities at runtime instead of relying only on version numbers.

## Installation

Run the installer for the principal agent:

```bash
./install.sh pi
./install.sh codex
```

The Pi installer also configures Herdr's official Pi integration. Reload or restart an already running Pi session after installation.

## Commands

```bash
dbz-crew preflight
dbz-crew dispatch --task-id <id> --prompt '<bounded task>'
dbz-crew dispatch --task-id <id> --prompt '<bounded task>' --parallel
dbz-crew status
dbz-crew rebase --task-id <id>
dbz-crew integrate --branch <worker-branch>
dbz-crew cleanup --task-id <id> --branch <worker-branch>
```

Pi runtime metadata is normally inherited from `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`. Troubleshooting or explicitly requested overrides are available through `--worker-provider`, `--worker-model`, and `--worker-thinking`.

Workers never merge, push, rebase `main`, or remove worktrees. Rebase, integration, and cleanup require separate explicit user requests.

## State and completion

State defaults to `${XDG_STATE_HOME:-~/.local/state}/dbz-crew` and can be moved with `DBZ_CREW_STATE_DIR`. Prompts, results, and completion events are private local state and must not be committed.

Pi completion events are delivered only to the original Pi session and use follow-up delivery, so they do not steer an active principal turn. Codex delivery waits until its principal is available.

## Validation

```bash
python3 -m unittest discover -s tools/dbz-crew/tests -v
TZ=UTC node --test agents/pi/extensions/dbz-crew-events/index.test.ts
tests/test-install.sh
```

The manual Pi and Codex checklist is in [`tests/SMOKE_DBZ_CREW.md`](../../tests/SMOKE_DBZ_CREW.md).
