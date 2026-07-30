---
name: dbz-crew
description: Create explicit parallel Codex workers through Herdr in isolated Git worktrees. Use only when the user explicitly asks to delegate a named task, create a worker, or run named tasks in parallel; do not use for ordinary planning, implementation, mentions of dbz-crew, or status questions.
---

# DBZ Crew

Use this skill only for an explicit request for parallel delegation. A request such as "delegue X", "crie um worker para X", or "faça X em paralelo" is explicit. Do not infer parallelism from a feature request, a plan, a request to investigate, or a mention of DBZ Crew.

This plugin has no lifecycle hooks and does not persist workflow instructions outside an explicit delegation request.

## Dispatch

- Create exactly one worker for each independent task the user names. Do not split a task or create extra research, test, or rebase workers on your own.
- Before every dispatch, run `dbz-crew preflight`. If it fails, report the missing prerequisite and do not create a worker.
- Dispatch with `dbz-crew dispatch --task-id <short-name> --prompt '<complete bounded task>'`. The worker owns its investigation, changes, validation, and Conventional Commit.
- If the user explicitly names another independent task while a worker is active, use `--parallel` for that additional dispatch. Do not use it merely to decompose one task.
- The command creates a Git worktree and a new tab in the principal's existing Herdr workspace. Do not use Codex's native subagent tool for this work.
- Keep the principal available: never wait for a worker. Continue the user's other requests and use `dbz-crew status` only when a snapshot is needed.

This rule also applies in Plan Mode: dispatch only when the user explicitly requests parallel execution in that prompt.

## Worker contract

Include a concise, bounded task and required validation. Workers must work only in their assigned worktree, not delegate further, keep unrelated files untouched, and never change `main`, merge, push, delete worktrees, or rebase `main`. They must finish with `DBZ-CREW RESULT:` including summary, validation, and blockers.

## Completion and local Git lifecycle

The monitor notifies the principal when a worker completes. Report the result and wait for the user's explicit direction; never automatically rebase, merge, or clean up.

- The CLI runs preflight again before each rebase, merge, and cleanup; stop and report the failure if it cannot proceed.
- On an explicit rebase request, reuse the same worker with `dbz-crew rebase --task-id <task>`.
- On an explicit merge request, run `dbz-crew integrate --branch <worker-branch>`; it performs a local non-fast-forward merge only when the branch is rebased on current `main`.
- After an explicit cleanup request following a merge, run `dbz-crew cleanup --task-id <task> --branch <worker-branch>`. It removes only a clean worktree and its worker tab.

Do not create pull requests, merge requests, or push branches unless the user separately asks.
