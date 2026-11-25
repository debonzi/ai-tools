# DB11 ShipIt Smoke Test

Use a disposable local repository with an initialized Wyrd project, a completed DB11
Plan with an explicitly accepted Plan Conclusion, and a small testable codebase. This
procedure does not authorize remote access, commits, pushes, deployment, delegation, or
changes outside the disposable repository.

## 1. Skill discovery

Load the local `packages/db11-skills` workspace in an isolated Pi profile or pass
`skills/db11-shipit` through Pi's explicit `--skill` option. Confirm Pi reports exactly
one `skill:db11-shipit` command and no extension is loaded by the skill.

## 2. Start from an accepted Plan

Invoke:

```text
/skill:db11-shipit start <completed-plan-ticket-id>
```

Confirm the agent:

- validates the Plan marker, completed state, decision-log acceptance, and non-placeholder
  Plan Conclusion;
- derives `plan:<plan-ticket-id>` without editing the terminal Plan;
- creates one `protocol:db11_shipit` Implementation Ticket per accepted functional
  slice and no child tasks;
- stores the protocol marker, Initiative identity, source Plan, functional outcome,
  scope, and acceptance criteria in every ticket;
- marks every new ticket `Unplanned`;
- adds no ticket dependency during start and no dependency to the Plan Ticket;
- does not inspect implementation details or prepare a Technical Plan;
- makes no production change;
- recommends `plan <first-implementation-ticket-id>` as the next operation.

Invoke `start` again and confirm it discovers the existing Initiative without creating
duplicates.

## 3. Resume planning in a fresh session

Exit Pi and start a fresh session. Invoke:

```text
/skill:db11-shipit resume <plan-ticket-id>
```

Confirm resume is read-only and reports the source Plan, Initiative identity, ticket
states, current planning target, latest technical checkpoint, blockers, and `plan` as
the next operation without relying on conversation history.

## 4. Accept a Technical Plan

Invoke:

```text
/skill:db11-shipit plan <implementation-ticket-id>
```

Request one clarification and partially accept one point. Confirm the clarification and
accepted subset are durable, status remains `In planning`, and no child task exists.
Then explicitly accept the complete proposal and confirm:

- accepted technical decisions are normative;
- the proposed task map has objective, functional coverage, expected result,
  verification, and dependency titles;
- status becomes `Technical plan accepted`;
- no production file or child task is created.

## 5. Materialize without implementing

Invoke:

```text
/skill:db11-shipit materialize <implementation-ticket-id>
```

Confirm the agent:

- creates exactly the accepted tasks with `protocol:db11_shipit` and
  `kind:implementation`;
- adds sibling dependencies only after all task IDs exist;
- updates the task map with IDs;
- sets ticket status to `Ready`;
- performs no production change.

Interrupt one disposable materialization after a partial create and confirm retry
reconciles existing tasks rather than duplicating them.

## 6. Execute and resume one task

Invoke:

```text
/skill:db11-shipit work <implementation-task-id>
```

Confirm the agent selects only an open, unblocked task under an unblocked parent,
preserves unrelated worktree changes, implements only the accepted scope, runs bounded
verification, records changed paths and results before completion, and changes the
parent from `Ready` to `Implementing`.

Exit during another open task, resume in a fresh session, and confirm the complete task,
accepted Technical Plan, active blockers, and required predecessor results are enough
to continue. Confirm no commit, push, deployment, remote mutation, or delegation occurs.

## 7. Read-only status

Record every Wyrd revision and invoke:

```text
/skill:db11-shipit status <plan-ticket-id>
```

Confirm it reports ticket planning states, Wyrd states, executable and blocked tasks,
consistency warnings, and next operation without changing any revision.

## 8. Conclude delivery

After all tasks are terminal, invoke:

```text
/skill:db11-shipit conclude <implementation-ticket-id>
```

Confirm unmet acceptance evidence keeps the ticket open. After satisfying the gate,
confirm the agent records delivered outcome, criterion evidence, verification,
deviations, and limitations; sets status `Delivered`; completes the ticket; and reports
remaining Initiative work without creating a root ticket.

## 9. Guardrail checks

In separate disposable attempts, confirm:

- an open, dismissed, unmarked, or unaccepted Plan cannot start ShipIt;
- start outside a Wyrd project never initializes one;
- resume and status never mutate resources;
- technical-plan acceptance does not authorize materialization or code changes;
- materialization does not authorize code changes;
- work refuses blocked tasks and blocked parent tickets;
- a functional gap stops technical planning or execution instead of changing accepted
  behavior;
- revision conflicts and corrupt state stop rather than overwrite;
- the source Plan Ticket remains unchanged throughout the lifecycle.
