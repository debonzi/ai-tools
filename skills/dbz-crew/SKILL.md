---
name: dbz-crew
description: Create explicit parallel Pi workers through Herdr, using isolated Git worktrees by default and optional read-only live-worktree exploration. Use only when the user explicitly asks to delegate a named task, create a worker, or run named tasks in parallel; do not use for ordinary planning, implementation, mentions of DBZ Crew, or status questions.
---

# DBZ Crew

Use this skill only for an explicit request for parallel delegation. Requests such as "delegate X", "create a worker for X", or "do X in parallel" are explicit. Do not infer parallelism from a feature request, plan, investigation request, or mention of DBZ Crew.

DBZ Crew creates Pi workers that inherit the principal's provider, model, and thinking level automatically. Do not select a different provider or model unless the user explicitly requests a supported Pi runtime override.

## Dispatch

- Create exactly one worker for each independent task the user names. Do not split a task or create extra research, test, or rebase workers on your own.
- Before every dispatch, run the matching preflight command. For implementation tasks, run `dbz-crew preflight`. For tasks explicitly requiring no repository file changes, run `dbz-crew preflight --read-only`.
- Dispatch implementation tasks with `dbz-crew dispatch --task-id <short-name> --prompt '<complete bounded task>'`.
- Dispatch explicitly exploratory or no-change tasks with `dbz-crew dispatch --read-only --task-id <short-name> --prompt '<complete bounded task>'`. This mode snapshots tracked changes and non-ignored untracked files in an isolated worktree and may start from a dirty, non-main worktree.
- Add `--committed-only` to both read-only preflight and dispatch only when the user requests committed content or a clean base. An explicit `--base <ref>` is valid only with this read-only option.
- Add `--in-place` to both read-only preflight and dispatch only when the user explicitly requests live-worktree exploration and accepts weaker isolation. Never select it merely because the principal worktree is dirty.
- If preflight fails, report the missing prerequisite and do not create a worker.
- If the user explicitly names another independent task while a worker is active, use `--parallel` for that additional dispatch. Do not use it merely to decompose one task.
- The command creates a new tab in the principal's existing Herdr workspace. It creates an isolated Git worktree unless the user explicitly requested `--in-place`. Do not use a native Pi subagent tool for this work.
- Keep the principal available: never wait for a worker. Continue the user's other requests and use `dbz-crew status` only when a snapshot is needed.

This rule also applies in planning modes: dispatch only when the user explicitly requests parallel execution in that prompt.

## Worker contract

Include a concise, bounded task and required validation. Workers must not delegate further, change `main`, merge, push, delete worktrees, or rebase `main`.

Implementation workers must work only in their assigned worktree, keep unrelated files untouched, and finish their changes with a Conventional Commit.

Read-only workers must not create, modify, remove, stage, or commit repository files. Isolated read-only workers fail validation if their captured snapshot changes. In-place workers emit a warning instead because concurrent changes cannot be attributed reliably.

Every worker must finish with `DBZ-CREW RESULT:` including summary, validation, and blockers.

## Completion and local Git lifecycle

The monitor delivers completion to the original principal session as a follow-up. Report the result and wait for the user's explicit direction; never automatically rebase or merge.

Successful isolated read-only workers are cleaned up automatically after their result is captured. If validation detects changes, DBZ Crew retains the tab, worktree, and branch for inspection. In-place read-only tabs are closed automatically after result capture.

For implementation workers:

- The CLI runs strict preflight again before each rebase, merge, and cleanup; stop and report the failure if it cannot proceed.
- On an explicit rebase request, reuse the same worker with `dbz-crew rebase --task-id <task>`.
- On an explicit merge request, run `dbz-crew integrate --branch <worker-branch>`; it performs a local non-fast-forward merge only when the branch is rebased on current `main`.
- After an explicit cleanup request following a merge, run `dbz-crew cleanup --task-id <task> --branch <worker-branch>`. It removes only a clean worktree and its worker tab.

Do not create pull requests, merge requests, or push branches unless the user separately asks.
