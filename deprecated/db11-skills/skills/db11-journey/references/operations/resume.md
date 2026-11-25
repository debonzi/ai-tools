# Resume or inspect a Journey

This operation discovers the minimum durable context for a named Journey. Inspection
is read-only. A request to continue also authorizes work only after one task has been
selected under the work operation.

## Locate the current phase

1. Run `wyrd status --json`.
2. List open tickets with the Journey label using `--summary --json`.
3. Partition them into unblocked and blocked tickets.

Expected state:

- exactly one open, unblocked phase ticket;
- zero or one blocked, prepared successor during an interrupted transition.

If multiple unblocked phase tickets exist, stop and report conflicting titles, phase
labels, and dependencies. Do not choose one by ID order.

If no unblocked phase exists:

- query `--status all` for the Journey label;
- if the latest phase is terminal and no open successor exists, report the Journey as
  complete under the modeled phases;
- if open tickets are all blocked, inspect their active blockers and report the
  inconsistent or externally blocked state;
- if no tickets exist, report that the Journey was not found.

## Load bounded context

For the current phase:

1. View the complete phase ticket.
2. List only its open task summaries.
3. Load the selected task only if the requester named it or asked to continue work.
4. Read predecessor tickets or completed tasks only when an input pointer requires
   verification.
5. Load only the reference matching the current `phase:*` label.

Select the first open, unblocked task in task-number order when continuation was
requested without a task. Never select a conclusion task while it has active blockers.

## Report

Return a compact checkpoint containing:

- Journey and destination;
- current phase and its completion gate;
- open takeable and blocked task titles;
- selected task, if any;
- durable predecessor conclusion already available in the phase input;
- blockers and recommended next action.

Do not restate completed exploration unless it is necessary to act on the checkpoint.
