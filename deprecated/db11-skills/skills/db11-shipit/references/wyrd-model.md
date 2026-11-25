# Wyrd model for DB11 ShipIt

Load this reference before creating or changing DB11 ShipIt resources.

## Identity and validation

The Initiative identity is the source Plan Ticket identity written as
`plan:<plan-ticket-id>`. The Plan Ticket ID remains the explicit resume input.

Every new Implementation Ticket and Implementation Task carries the canonical
`protocol:db11_shipit` label. Every task additionally carries `kind:implementation`.
The protocol label is a discovery index, not sufficient identity proof.

A valid Implementation Ticket body contains:

- `Protocol: DB11 ShipIt`;
- `Initiative identity: plan:<plan-ticket-id>`;
- an explicit source Plan Ticket ID.

A task belongs to DB11 ShipIt only when its parent is a validated Implementation Ticket
and its body matches the Implementation Task model. The source Plan Ticket must contain
`Protocol: DB11 Plan`, be completed rather than dismissed, and contain an accepted,
non-placeholder Plan Conclusion.

## Implementation Ticket

Use a functional, outcome-oriented title such as `Deliver password reset confirmation`.
For a necessary shared enabler, state its delivered capability, such as
`Provide transactional token storage`. Do not prefix titles with IDs or protocol names.

Build the body from `../assets/implementation-ticket-body.md`. Planning status is one
of these exact values:

- `Unplanned`
- `In planning`
- `Technical plan accepted`
- `Ready`
- `Implementing`
- `Delivered`

Every new ticket starts `Unplanned`. An explicit `plan` operation changes only its
selected ticket to `In planning`. Keep the accepted Plan inputs compact and reference
the source instead of copying its raw discussion.

## Implementation Task

Use a bounded imperative title such as `Add token consumption transaction`. Build the
body from `../assets/implementation-task-body.md`. Every task must map to acceptance
criteria or identify the technical-enabler outcome it supports.

Tasks exist only after the parent Technical Plan is accepted. Task dependencies are
allowed only between siblings and represent genuine execution prerequisites.

## Efficient reads

Use only Wyrd CLI commands and prefer summaries:

```text
wyrd status --json
wyrd ticket view <plan-ticket-id> --json
wyrd ticket list --status open --label protocol:db11_shipit --summary --json
wyrd ticket list --status all --label protocol:db11_shipit --summary --json
wyrd ticket list --status all --label protocol:db11_shipit \
  --text "Initiative identity: plan:<plan-ticket-id>" --summary --json
wyrd ticket view <implementation-ticket-id> --json
wyrd task list --ticket <implementation-ticket-id> --status open --summary --json
wyrd task list --ticket <implementation-ticket-id> --status all --summary --json
wyrd task view <implementation-task-id> --json
```

Validate complete ticket bodies before treating label matches as Initiative members.
Use `--status all` for Initiative inventory, duplicate prevention, terminal history,
conclusion, or interrupted materialization; otherwise prefer open summaries.

## Safe creates

Use `--body-file -` or a private temporary UTF-8 file:

```text
wyrd ticket create --title <title> --body-file - \
  --label protocol:db11_shipit --json
wyrd task create --ticket <ticket-id> --title <title> --body-file - \
  --label protocol:db11_shipit --label kind:implementation --json
```

Create all tickets before adding genuine inter-ticket dependencies. Create all sibling
tasks before adding task dependencies. After IDs exist, re-read and optimistically
update each ticket's task map. If creation fails partway, stop and report exact created
resources; retry only after reconciling existing state.

## Safe edits

Immediately before editing, view the complete active resource and retain its revision:

```text
wyrd ticket edit <ticket-id> --body-file - \
  --expected-revision <revision> --json
wyrd task edit <task-id> --body-file - \
  --expected-revision <revision> --json
```

On `revision_conflict`, re-read and reconcile. Never overwrite concurrent changes. A
completed source Plan Ticket is read-only and must never be edited to add Initiative
metadata.

## Dependencies

Initiative membership is represented by the body identity and source reference, not a
dependency. Never make an Implementation Ticket depend on its completed Plan Ticket.

Add ticket dependencies only when one delivery slice cannot execute before another.
Add task dependencies only between sibling tasks. The resource before `--blocked-by`
is the blocked resource:

```text
wyrd ticket dependency add <ticket> --blocked-by <predecessor> --json
wyrd task dependency add <ticket.task> --blocked-by <ticket.predecessor> --json
```

## Terminal transitions

Persist a task result before completing it. Persist `Delivered` status and the delivery
result before completing a ticket. Use explicit noninteractive confirmation:

```text
wyrd task complete <task-id> --yes --json
wyrd task dismiss <task-id> --yes --json
wyrd ticket complete <ticket-id> --yes --json
```

Dismiss only work explicitly determined to be unnecessary and record why. Do not
complete a ticket with open tasks or unmet acceptance criteria.

## Error handling

With `--json`, branch on `error.code`, not human message text.

- `project_not_found`: stop; never initialize implicitly.
- `revision_conflict`: re-read and reassess the intended edit.
- `ticket_not_found` or `task_not_found`: verify explicit identity.
- `resource_not_active`: stop; terminal resources cannot be edited or reopened.
- `ticket_has_open_tasks`: keep the ticket open and report remaining tasks.
- `blocked_by_open_dependency`: report the active blocker; do not bypass it.
- storage, transaction, corrupt-data, or internal errors: stop without assuming whether
  a write occurred. Use `wyrd doctor --json` only when normal reads report invalid or
  corrupt project data.

## Consistency checks

A healthy active Initiative has:

- one completed source Plan Ticket with an accepted Plan Conclusion;
- one or more validated Implementation Tickets with the same Initiative identity;
- no child tasks under `Unplanned`, `In planning`, or `Technical plan accepted` tickets;
- a complete accepted task map before a ticket becomes `Ready`;
- every child task carrying both canonical labels;
- no dependency used only for Initiative membership;
- no completed task with an empty Result;
- no completed ticket without `Delivered` status and a delivery result.

Stop and report discrepancies instead of repairing, relabeling, or reordering them
silently.
