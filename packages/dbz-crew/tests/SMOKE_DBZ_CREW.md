# DBZ Crew Smoke Test

Run implementation checks from a clean `main` worktree inside a Herdr-managed Pi session after installing `@debonzi/dbz-crew`, running `/skill:dbz-crew-setup`, and installing the official Herdr Pi integration after explicit confirmation. Read-only checks intentionally cover dirty and non-main source worktrees.

Resolve `<dbz-crew>` through the loaded skill as `python3 <dbz-crew-skill-directory>/scripts/dbz-crew`.

## Pi principal and Pi worker

1. Start Pi in Herdr and run `<dbz-crew> preflight`.
2. Confirm the JSON reports `principal_agent: "pi"` and the active provider, model, and thinking level.
3. Explicitly ask Pi to delegate a bounded file change through DBZ Crew.
4. In the worker tab, confirm the process is Pi and its startup arguments use the principal's provider, model, and thinking level.
5. Keep the principal busy with a separate task until the worker finishes.
6. Confirm the completion does not steer the active turn and is delivered afterward as a follow-up.
7. Confirm the principal reads the result, reports it, and does not rebase, merge, or clean up automatically.
8. Explicitly request rebase, integration, and cleanup in separate turns and verify each safety gate.

## Read-only delegation

1. On a non-main branch, modify a tracked file and add both a non-ignored untracked file and an ignored file.
2. Run `<dbz-crew> preflight --read-only` and confirm it succeeds while reporting the branch and dirty state.
3. Delegate a bounded inspection with `<dbz-crew> dispatch --read-only`.
4. Confirm the worker uses an isolated worktree containing the tracked change and non-ignored untracked file but not the ignored file.
5. Confirm an unchanged snapshot produces a completion event and automatically removes the worker tab, branch, and worktree while retaining the private result.
6. Repeat with a worker instructed to create a file; confirm validation fails and retains its resources for inspection.
7. Run with `--read-only --committed-only` and confirm local changes are absent. Repeat with `--base <ref>` and confirm the requested committed tree is used.
8. Run an explicitly requested `--read-only --in-place` inspection, modify the source concurrently, and confirm the result warns without attributing or failing on that change.
9. Confirm ordinary dispatch, rebase, integration, and cleanup still reject a dirty or non-main principal worktree.

## Package isolation

After package setup, verify:

```bash
pi list
test -f ~/.pi/agent/extensions/herdr-agent-state.ts
test ! -e ~/.local/bin/dbz-crew
git status --short
```

Confirm `pi list` includes `npm:@debonzi/dbz-crew` and no skill or DBZ Crew event-extension symlinks point into this checkout. The bundled skill and extension must load together without package-filter edits.

Installing or updating Herdr's Pi integration must not create files under `agents/pi/extensions/` in this repository.
