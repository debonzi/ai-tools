# Resume a DB11 Plan

Resume is read-only until the requester continues discussion, clarifies the current
topic, or explicitly accepts a proposal.

## Locate and validate

Require an explicit ticket ID. Run `wyrd status --json`, then view only that ticket.
Confirm that:

- it is open;
- its Tracking section contains `Protocol: DB11 Plan`;
- its label metadata contains `protocol:db11_plan`, or report that it is a marker-only
  legacy Plan Ticket;
- it has no protocol-required dependencies or external relationship assumptions;
- its topic map and child task IDs are coherent.

The label without the Tracking marker is not sufficient validation. If the ticket is
terminal, report its final conclusion or incomplete terminal state instead of attempting
to resume it. If the ID is not a DB11 Plan ticket, stop without reinterpreting it.

## Load bounded state

1. View the complete ticket.
2. List all task summaries to establish accepted, dismissed, and open counts and inspect
   their canonical labels without excluding unlabeled legacy topics.
3. List open task summaries in numeric order.
4. Select the explicitly named child task when valid; otherwise select the
   lowest-numbered open task.
5. View only the selected task.
6. Load completed topic bodies only when the decision log is insufficient or the
   current topic references them for verification.

Expected state has at most one open task marked `In discussion`. If another open task
is selected explicitly, do not silently abandon the current topic; report the conflict
and ask whether to reorder discussion.

## Reconcile interrupted materialization

If the ticket topic map and existing child tasks differ, report the exact partial
state. Recreate a missing task only when the ticket clearly records its intended title
and scope and no sibling duplicates it. Give every recreated task
`protocol:db11_plan`, re-read, and optimistically update the ticket afterward. Never
duplicate a successfully created resource.

## Continue

Return a compact checkpoint:

- ticket objective and ID;
- accepted decision log;
- completed, dismissed, and open topic counts;
- selected current topic and its latest clarification;
- pending topic titles;
- legacy or missing-label warnings, other consistency warnings, and blockers.

If continuation was requested and the selected topic was only `Not discussed`, prepare
and persist its researched initial proposal before presenting it. Otherwise restate
only the current unresolved acceptance points, not the entire historical discussion.
