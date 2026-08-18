# Prepare a Technical Plan

Use this operation for one explicit, active Implementation Ticket. It authorizes
read-only repository research and durable edits to that ticket, but not child-task
creation or production changes.

## Select and validate

1. Validate the parent Initiative and completed source Plan.
2. Confirm the ticket body has `Protocol: DB11 ShipIt`, the matching Initiative
   identity, and the source Plan reference.
3. Confirm the ticket is open and load its complete body and revision.
4. List child task summaries. Normally there are none before materialization.
5. Stop on stale, contradictory, or behaviorally insufficient Plan inputs.

If another ticket is `In planning`, do not silently switch. Ask whether to defer it and
persist that state change before selecting this ticket.

## Research before asking

Inspect repository instructions, relevant source, tests, schemas, interfaces, build
configuration, and authorized documentation. Distinguish verified findings from
hypotheses. Do not ask the requester for discoverable codebase facts.

Keep research bounded to the selected functional slice and shared interfaces it
actually depends on.

## Build the proposal

Persist and present:

- verified codebase findings;
- recommended technical approach;
- affected components, interfaces, and paths;
- data, migration, rollback, and compatibility handling;
- test and verification strategy mapped to every acceptance criterion;
- material risks and constraints;
- proposed Implementation Tasks with objective, functional coverage, expected result,
  verification, and dependency titles;
- genuine predecessor Implementation Tickets;
- material acceptance points.

Routine coding choices need not become requester questions. Escalate irreversible or
high-impact architecture, interface, security, data, migration, and operational choices.

Set status to `In planning` while any material point remains unresolved. Use a fresh
revision for every edit.

## Clarification and partial acceptance

Persist clarifications and accepted subsets chronologically. Keep the normative
Accepted technical decisions section separate from unaccepted proposal text. Partial
or ambiguous acceptance leaves status `In planning` and names the remaining points.

A functional ambiguity is not a technical choice. Persist it as a blocker and stop for
a separate Plan correction.

## Complete acceptance

After explicit acceptance of the complete proposal:

1. re-read the ticket and verify no functional input changed;
2. make Accepted technical decisions a complete normative record;
3. make the proposed task map complete and internally coherent;
4. set status to `Technical plan accepted`;
5. edit with the current revision;
6. report that `materialize <ticket-id>` is required next.

Acceptance does not create tasks and does not authorize implementation.

## Replanning after materialization

A `Ready` or `Implementing` ticket may be replanned only after an explicit request and
a material blocker. Preserve completed task results. Reconcile the accepted plan with
open and terminal tasks, identify tasks to add or explicitly dismiss, and return the
ticket to `Technical plan accepted`. Task reconciliation still requires a separate
`materialize` operation. Never rewrite history or hide deviations.
