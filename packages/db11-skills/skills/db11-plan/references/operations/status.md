# Inspect DB11 Plan status

Status is strictly read-only. It accepts an optional Plan Ticket ID. Without an ID, it
returns a read-only inventory of DB11 Plans instead of guessing which one to resume.

## Inspect one Plan Ticket

When an ID is present:

1. Run `wyrd status --json` to verify project scope.
2. View only the explicitly named ticket.
3. Confirm `Protocol: DB11 Plan` in its Tracking section.
4. Verify `protocol:db11_plan` in its labels. If the marker is valid but the label is
   absent, continue as a legacy Plan Ticket and report the warning. A label without the
   marker is not a DB11 Plan.
5. List all child task summaries with `--status all --summary --json`. Inspect their
   labels, but do not omit an unlabeled legacy topic from counts.
6. View the current task only when its discussion state or unresolved points are needed
   for an accurate report.

If the ID does not identify a validated current or legacy Plan Ticket, stop without
reinterpreting it.

## Inventory DB11 Plans

When no ID is present:

1. Run `wyrd status --json`.
2. List labeled candidates with:

   ```text
   wyrd ticket list --status open --label protocol:db11_plan --summary --json
   ```

3. Find marker-only legacy candidates with:

   ```text
   wyrd ticket list --status open --text "Protocol: DB11 Plan" --summary --json
   ```

4. If the requester explicitly asks for completed, dismissed, historical, or all plans,
   repeat both targeted queries with `--status all`. Otherwise inventory only open
   tickets.
5. Deduplicate candidates by ticket ID, view each candidate, and require the exact
   Tracking marker before classifying it as a Plan Ticket.
6. For every validated ticket, list all child task summaries to calculate topic counts
   and label consistency. View a task body only when required to resolve the current
   topic or an inconsistency.

A labeled candidate without the marker is an identity inconsistency and must be
reported separately, not included as a DB11 Plan. A marker-only candidate is a legacy
Plan Ticket. Do not add labels, edit checkpoints, activate topics, or otherwise migrate
resources during inventory.

## Report one Plan Ticket

Return:

- ticket title, ID, and open or terminal state;
- completed, dismissed, and open topic counts;
- current topic, defined as the lowest-numbered open topic unless the bodies reveal a
  different single in-discussion task;
- pending topic titles in numeric order;
- whether synthesis is ready;
- legacy state, missing labels, inconsistencies, blockers, or unexpected dependencies;
- the recommended next operation: resume, conclude, or inspect the final conclusion.

Keep accepted decisions summarized from the ticket decision log. Do not load and
repeat every completed task body.

## Report an inventory

Return:

- the number of validated open plans, or validated plans of all states when requested;
- each Plan Ticket title, ID, status, topic counts, and current topic when one exists;
- which plans are marker-only legacy resources;
- labeled candidates rejected for a missing marker and any topic-label inconsistencies;
- the explicit ticket ID needed for resume or conclusion.

If exactly one open plan exists, it may receive the detailed status format, but do not
resume or mutate it automatically. Keep the report compact and omit raw command output.
