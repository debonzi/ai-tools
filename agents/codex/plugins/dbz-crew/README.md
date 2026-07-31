# DBZ Crew Codex Adapter

This local Codex plugin exposes the shared `skills/dbz-crew` policy to Codex. Codex copies local plugins into an isolated cache and does not preserve out-of-tree skill symlinks, so `skills/dbz-crew/SKILL.md` is a packaging mirror of the canonical shared skill. Tests require the two files to remain identical.

The agent-neutral CLI lives in `tools/dbz-crew` and supports both Codex and Pi principals.

Install the Codex adapter through the repository installer:

```bash
./install.sh codex
```

See [`tools/dbz-crew/README.md`](../../../../tools/dbz-crew/README.md) for requirements, commands, state, and validation.
