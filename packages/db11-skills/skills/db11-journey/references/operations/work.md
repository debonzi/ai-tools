# Work on a phase task

Use this operation for one selected task in the single open, unblocked phase ticket.
Load the current phase reference before acting.

## Select safely

1. Confirm the parent phase ticket is open and unblocked.
2. List open sibling tasks with `--summary --json`.
3. Use the task named by the requester, or the first open, unblocked task in numeric
   order.
4. View the complete task and its active dependencies.
5. Stop if its inputs are stale, contradictory, unsafe, or insufficient.

Do not work tasks from a prepared but blocked successor phase.

## Work by kind

- `kind:research`: inspect bounded local or public sources; persist conclusions,
  essential evidence, uncertainty, and decision impact.
- `kind:questioning`: ask one concise material question per turn; provide options and a
  recommendation when useful, but let the requester make the material decision;
  persist accepted answers.
- `kind:decision`: synthesize known inputs, present trade-offs, and persist the
  requester's accepted choice and consequences.
- `kind:prototype`: create only the disposable decision-support artifact authorized by
  the Planning task; do not turn it into production implementation.
- `kind:implementation`: execute only the bounded accepted plan; report material
  uncertainty instead of redesigning it.
- `kind:conclusion`: do not handle as ordinary work; load the advance operation.

## Persist before completion

Write a compact `Result` into the task body before completing it. Include only the
answer or delivered outcome, necessary evidence or artifact references, accepted
trade-offs, and remaining blockers. Re-read the task and use its current revision for
the edit.

Complete the task only when its expected output is satisfied and it has no active
blocker. Otherwise leave it open and persist a checkpoint in its body when useful.

## Add newly discovered phase work

A new task is allowed only when it is required to close the current phase and is
concrete now.

Before creating it:

1. verify it does not belong to a later phase;
2. inspect existing open and terminal siblings to avoid duplication;
3. verify the conclusion task is still open.

After creating a non-conclusion task, immediately make the conclusion task depend on
it. If the conclusion task is already terminal, stop and report a lifecycle conflict
instead of improvising a replacement.

## After work

Refresh the task summaries. Report the durable result, newly unblocked tasks, phase
progress, and next action. Do not advance the phase automatically when its conclusion
task becomes takeable.
