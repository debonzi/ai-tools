# Wyrd model for DB11 Plan

Load this reference before creating or changing DB11 Plan resources.

## Resource model

A DB11 Plan uses exactly one standalone Plan Ticket and one child Wyrd task per Plan
Topic. Every newly created Plan Ticket and Plan Topic has the canonical
`protocol:db11_plan` label. The label satisfies Wyrd's 20-character limit and label
syntax. DB11 Plan uses no ticket or task dependencies. The ticket ID remains the resume
identity.

The label is a discovery index, not sufficient proof that a resource belongs to the
protocol. The ticket body must contain `Protocol: DB11 Plan` in its Tracking section so
an operation can validate a candidate. A task is a Plan Topic only when it belongs to a
validated Plan Ticket and its body represents a topic. A label on an unrelated ticket
or task does not make it a DB11 Plan resource.

## Plan Ticket title and body

Use a concise human-readable imperative title such as `Define Crewlead behavior` or
`Choose an authentication migration strategy`. Do not prefix the title with an ID or
protocol name.

Build the body from `../assets/ticket-body.md`. Preserve the section order and clearly
mark candidate direction as unaccepted. After task creation, update the topic map with
titles and Wyrd IDs.

## Plan Topic task title and body

Use a decision-oriented title such as `Define clean member context`, not a question or
a generic activity such as `Discuss context`.

Build each body from `../assets/topic-task-body.md`. Inactive topics start as `Not
discussed`. The first topic starts as `In discussion` and includes its researched
initial proposal. Keep clarifications chronological and keep the final Accepted
decisions section normative rather than conversational.

## Efficient reads

Use only Wyrd CLI commands and prefer summaries:

```text
wyrd status --json
wyrd ticket list --status open --label protocol:db11_plan --summary --json
wyrd ticket list --status all --text "Protocol: DB11 Plan" --summary --json
wyrd ticket view <ticket-id> --json
wyrd task list --ticket <ticket-id> --status open --summary --json
wyrd task list --ticket <ticket-id> --status all --summary --json
wyrd task view <ticket.task> --json
```

For operations with an explicit ID, view only that ticket. Use targeted ticket-list
queries only for read-only inventory or legacy discovery, deduplicate candidates by ID,
and validate their complete bodies before reporting them as DB11 Plans. Use `--status
all` for requested terminal history, topic history, conclusion readiness, or
inconsistency diagnosis; use `--status open` during ordinary continuation and default
inventory.

## Safe creates

Use `--body-file -` or a private temporary UTF-8 file for Markdown bodies:

```text
wyrd ticket create --title <title> --body-file - --label protocol:db11_plan --json
wyrd task create --ticket <ticket-id> --title <title> --body-file - \
  --label protocol:db11_plan --json
```

Create Plan Topic tasks in intended discussion order with the canonical label and no
dependencies. This also applies to a correction or newly discovered topic added to a
legacy Plan Ticket. After all tasks exist, re-read the ticket and use an optimistic
edit to add their IDs to the topic map.

If creation fails partway, stop and report the exact created resources. A later resume
must reconcile the ticket topic map with existing child tasks before creating anything
missing; never repeat successful creates blindly.

## Safe edits

Immediately before editing, view the complete resource and retain its `revision`:

```text
wyrd task edit <task-id> --body-file - --expected-revision <revision> --json
wyrd ticket edit <ticket-id> --body-file - --expected-revision <revision> --json
```

On `revision_conflict`, re-read and reconcile. Never overwrite concurrent changes.
Keep edits minimal in meaning even when Wyrd requires replacing the complete body.
Do not add a missing protocol label as an incidental part of status, resume, discussion,
or conclusion. Label migration is a separate mutation and requires explicit requester
authorization.

## Legacy compatibility

A ticket with the protocol marker but without `protocol:db11_plan` may predate the label
requirement. Explicit-ID operations may treat it as a legacy Plan Ticket after validating
its body and child tasks. Report its missing label instead of rejecting it or mutating
it automatically. Missing labels on its existing Plan Topics receive the same treatment.

Read-only inventory may supplement label discovery with an exact text search for the
protocol marker. Text matches are only candidates and require complete-body validation.
A candidate with the label but without the marker is inconsistent, not a Plan Ticket.
Wyrd cannot edit terminal resources, so do not promise complete backfill of legacy
plans.

## Terminal transitions

Persist the accepted decision or dismissal reason before a terminal transition. Then
use explicit noninteractive confirmation:

```text
wyrd task complete <task-id> --yes --json
wyrd task dismiss <task-id> --yes --json
wyrd ticket complete <ticket-id> --yes --json
```

Complete a task only after explicit acceptance and after its body and the ticket
decision log are durable. Dismiss a task only after the requester explicitly decides
it is no longer relevant. Complete the ticket only after every topic is terminal and
the Plan Conclusion is accepted and persisted.

## Error handling

With `--json`, branch on `error.code`, not human message text.

- `project_not_found`: stop; never initialize implicitly.
- `revision_conflict`: re-read and reassess the intended edit.
- `ticket_not_found` or `task_not_found`: verify the explicit identity.
- `resource_not_active`: stop; Wyrd 0.1.x cannot reopen it.
- `ticket_has_open_tasks`: keep the ticket open and report remaining topics.
- `blocked_by_open_dependency`: diagnose unexpected external mutation; DB11 Plan
  creates no dependencies.
- storage, transaction, corrupt-data, or internal errors: stop without assuming whether
  a write occurred. Use `wyrd doctor --json` only for read-only diagnosis when normal
  reads report invalid or corrupt project data.

## Consistency checks

A healthy newly created active DB11 Plan has:

- one open standalone Plan Ticket with `protocol:db11_plan` and the protocol marker;
- every Plan Topic carrying `protocol:db11_plan` under that ticket;
- zero or more terminal topics followed by open topics in numeric order;
- at most one open task whose body says `In discussion`;
- no protocol-created dependencies;
- a ticket decision-log entry for every completed or dismissed topic;
- no completed topic whose Accepted decisions section is empty.

A missing expected label is a legacy or consistency warning: do not exclude the resource
from counts, repair it silently, or treat the label as a substitute for body and parent
validation. A label without the ticket marker is an identity inconsistency. Stop and
report other discrepancies instead of repairing or reordering them silently.
