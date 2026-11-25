# Work on an Implementation Task

Use this operation only for one explicit Implementation Task. It authorizes the bounded
local production changes defined by that task, not unrelated work, commits, deployment,
remote mutations, or delegation.

## Select safely

1. Validate the task's parent as an open DB11 ShipIt Implementation Ticket.
2. Validate the completed source Plan and matching Initiative identity.
3. Require parent status `Ready` or `Implementing` and confirm the parent ticket is not
   blocked by an active ticket dependency.
4. Require the task to be open, carry both canonical labels, and have no active sibling
   blocker.
5. Load the complete task, accepted Technical Plan, necessary predecessor results, and
   relevant repository instructions.
6. Inspect repository state and preserve unrelated requester changes.

Stop if inputs are stale, contradictory, unsafe, or insufficient.

## Execute bounded work

Implement only the task's Objective and Scope. Follow accepted architecture, interfaces,
constraints, and prohibited scope expansion. Run the task's verification plus the
smallest relevant project checks required by repository instructions.

Do not silently redesign accepted behavior or material architecture. On a material gap:

1. stop before speculative expansion;
2. preserve a useful checkpoint in the task Result when safe;
3. report whether functional correction or explicit technical replanning is required;
4. leave the task open.

Do not overwrite unrelated worktree changes. Do not commit, push, deploy, access remote
services, or delegate without separate explicit authorization.

## Persist and complete

Before task completion, write a compact Result containing:

- changed paths or components;
- delivered technical outcome;
- verification commands and outcomes;
- accepted bounded deviations;
- remaining limitations or blockers.

Re-read and edit with the current revision. Complete the task only when Expected result
and Verification are satisfied and no active blocker remains.

On the first successful work operation for a `Ready` ticket, optimistically change the
parent status to `Implementing`. Do not complete the parent ticket when the final task
completes.

## Report

Refresh open task summaries and report the durable result, verification, changed scope,
newly unblocked tasks, deviations, blockers, and next operation. If no open task remains,
recommend `conclude <implementation-ticket-id>`.
