# Materialize Implementation Tasks

Use this operation only after an explicit request for one Implementation Ticket. It
authorizes child-task and genuine dependency creation, but not production changes.

## Preconditions

From fresh reads, require:

- an open validated Implementation Ticket;
- a completed and accepted source Plan;
- planning status `Technical plan accepted`;
- complete Accepted technical decisions;
- a task map defining title, objective, functional coverage, inputs, scope, constraints,
  expected result, verification, and dependency titles;
- no unresolved functional or technical blocker.

Inspect all existing child task summaries, including terminal history. If tasks already
exist, treat the operation as interrupted materialization or explicit replanning and
reconcile by title, scope, and recorded map. Never duplicate successful creates.

## Create tasks

Build each body from `../../assets/implementation-task-body.md`. Create every missing
task with both `protocol:db11_shipit` and `kind:implementation`. Create tasks in intended
execution order but do not rely on ID order as a dependency.

After all tasks exist:

1. add only accepted sibling dependencies in a second pass;
2. add accepted inter-ticket dependencies only when genuine execution ordering requires
   them and both tickets are active;
3. re-read the parent ticket;
4. update the task map with Wyrd IDs and dependency IDs;
5. set planning status to `Ready`;
6. edit with the current revision.

Do not make the ticket depend on its source Plan. Do not create generic component tasks
that lack functional coverage unless the accepted plan identifies a technical-enabler
outcome.

## Partial failure

On any failed create, dependency, or edit, stop and report:

- resources successfully created;
- dependencies successfully added;
- intended operations not completed;
- current parent status and revision.

A retry must inspect existing state first. Do not delete successful work or repeat
creates blindly.

## Report

Report the ticket, materialized task titles and IDs, dependency order, immediately
executable tasks, blockers, and the fact that only `work <task-id>` authorizes code
changes.
