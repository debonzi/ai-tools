# Resume DB11 ShipIt

Resume is read-only. It reconstructs the minimum Initiative context from the completed
Plan Ticket and its Implementation Tickets without authorizing technical-plan edits,
task creation, or production changes.

## Locate the Initiative

1. Run `wyrd status --json`.
2. View the explicit source Plan Ticket and validate it as a completed DB11 Plan with an
   accepted Plan Conclusion.
3. Derive `plan:<plan-ticket-id>`.
4. List all tickets with `protocol:db11_shipit` and the exact Initiative identity text
   using `--status all --summary --json`.
5. View each candidate body only as needed to validate its marker, identity, source Plan
   reference, and planning status.

If no valid tickets exist, report that ShipIt has not started. Separate labeled
candidates with missing or conflicting markers from valid members; never repair them
during resume.

## Select bounded context

When the requester names an Implementation Ticket, validate it belongs to the
Initiative and load it completely. When a task is named, validate its parent first and
then load the complete task and active blockers.

Without an explicit resource, recommend one target in this order:

1. the single ticket already `In planning`;
2. the lowest-ID `Unplanned` ticket;
3. a `Technical plan accepted` ticket awaiting materialization;
4. an open, unblocked `Ready` or `Implementing` ticket;
5. an open ticket ready for conclusion.

If multiple tickets claim `In planning`, report the inconsistency rather than choosing.
Do not select a task from a blocked parent ticket or a blocked task.

## Load minimum state

For a planning target, retain the Plan Conclusion, selected ticket, referenced evidence,
and no child bodies unless reconciling interrupted materialization. For execution,
retain the selected ticket, open task summaries, one selected task, active blockers,
and required predecessor results.

## Report

Return a compact checkpoint with:

- Initiative identity and source Plan;
- Implementation Ticket counts by planning status and Wyrd state;
- selected ticket or task;
- accepted technical decisions or latest planning checkpoint;
- active blockers and consistency warnings;
- exact recommended operation: `plan`, `materialize`, `work`, or `conclude`.

Do not mutate resources or continue automatically.
