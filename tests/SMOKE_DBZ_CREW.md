# DBZ Crew Smoke Test

Run these checks from a clean `main` worktree inside a Herdr-managed session after installing the matching agent integration.

## Pi principal and Pi worker

1. Start Pi in Herdr and run `dbz-crew preflight`.
2. Confirm the JSON reports `principal_agent: "pi"` and the active provider, model, and thinking level.
3. Explicitly ask Pi to delegate a bounded file change through DBZ Crew.
4. In the worker tab, confirm the process is Pi and its startup arguments use the principal's provider, model, and thinking level.
5. Keep the principal busy with a separate task until the worker finishes.
6. Confirm the completion does not steer the active turn and is delivered afterward as a follow-up.
7. Confirm the principal reads the result, reports it, and does not rebase, merge, or clean up automatically.
8. Explicitly request rebase, integration, and cleanup in separate turns and verify each safety gate.

## Codex regression

1. Start Codex in Herdr and run `dbz-crew preflight`.
2. Explicitly delegate a bounded file change.
3. Confirm the worker process is Codex and uses an isolated worktree and Herdr tab.
4. Keep the principal busy until the worker finishes and confirm completion waits for availability.
5. Confirm status, explicit rebase, explicit integration, and explicit cleanup retain their previous behavior.

## Installation isolation

After the Pi installation, verify:

```bash
test -d ~/.pi/agent/extensions && test ! -L ~/.pi/agent/extensions
test -d ~/.pi/agent/skills && test ! -L ~/.pi/agent/skills
test -f ~/.pi/agent/extensions/herdr-agent-state.ts
git status --short
```

Installing or updating Herdr's Pi integration must not create files under `agents/pi/extensions/` in this repository.
