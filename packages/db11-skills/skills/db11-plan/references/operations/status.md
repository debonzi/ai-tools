# Inspect DB11 Plan status

Status is strictly read-only.

## Read

1. Run `wyrd status --json` to verify project scope.
2. View the explicitly named ticket.
3. Confirm `Protocol: DB11 Plan` in its Tracking section.
4. List all child task summaries with `--status all --summary --json`.
5. View the current task only when its discussion state or unresolved points are needed
   for an accurate report.

Do not inspect unrelated tickets, edit checkpoints, activate a pending topic, or infer
acceptance during status inspection.

## Report

Return:

- ticket title, ID, and open or terminal state;
- accepted, dismissed, and open topic counts;
- current topic, defined as the lowest-numbered open topic unless the bodies reveal a
  different single in-discussion task;
- pending topic titles in numeric order;
- whether synthesis is ready;
- inconsistencies, blockers, or unexpected dependencies;
- the recommended next operation: resume, conclude, or inspect the final conclusion.

Keep accepted decisions summarized from the ticket decision log. Do not load and
repeat every completed task body.
