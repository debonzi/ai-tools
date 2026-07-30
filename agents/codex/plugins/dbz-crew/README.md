# DBZ Crew

DBZ Crew is a Codex plugin and command-line tool for explicitly delegating
independent tasks to Codex workers in isolated Git worktrees managed through
Herdr.

## Requirements

- Codex
- Herdr
- Git
- Python 3

Install it through the repository installer:

```bash
./install.sh codex
```

## Pi compatibility

DBZ Crew is not compatible with Pi today. The current implementation:

- requires the principal Herdr pane to report `agent: codex`;
- starts every worker with `herdr agent start --kind codex`;
- packages its invocation policy as a Codex plugin and skill;
- sends completion events back to a Codex principal session.

Future Pi support would require a Pi-specific integration for worker startup,
resource loading, and completion delivery. Shared Git worktree and lifecycle
logic could then be extracted from the Codex adapter, but no compatibility
layer is implemented or planned in this version.
