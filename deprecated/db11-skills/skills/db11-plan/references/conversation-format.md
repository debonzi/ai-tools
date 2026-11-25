# DB11 Plan conversation format

Use the requester's language unless project instructions require another language for
conversation. Durable Wyrd bodies follow the project's documentation language.

## Initial response

After research and materialization, report compactly:

1. the Plan Ticket title and ID;
2. the main findings and candidate direction, explicitly marked unaccepted;
3. a bullet list of the Plan Topics in intended order;
4. the first topic using the presentation format below.

Do not expose raw command output or discarded exploration.

## Topic presentation

Use this structure, omitting empty sections:

```markdown
## <task-id> — <topic title>

<short context and relevant evidence>

### Proposal

<recommended normative direction>

### Alternatives and trade-offs

- **Alternative:** consequence.

### Points for acceptance

1. <concrete decision>
2. <concrete decision>

<one direct acceptance or clarification question>
```

Prefer a researched recommendation over a questionnaire. Keep options materially
distinct. Do not ask the requester for facts that can be inspected safely.

## Clarification response

When the requester asks for clarification:

1. answer only the uncertainty raised;
2. explain the distinction or consequence with bounded examples;
3. provide a refined normative sentence when useful;
4. persist the clarification under the current task;
5. leave Accepted decisions unchanged and keep the task open;
6. ask whether the clarified point is accepted.

Do not present the next topic in the same response.

## Acceptance response

When acceptance is explicit:

1. persist the complete accepted definition in the Plan Topic task;
2. append a compact entry to the ticket decision log;
3. complete the Plan Topic task;
4. mark the next open topic as in discussion and persist its initial proposal;
5. report the completed topic in one sentence;
6. present the next topic in the standard format.

If no open topic remains, report that synthesis is ready and wait for an explicit
`conclude` request. Do not complete the ticket automatically.

## Partial or ambiguous acceptance

Quote or summarize the accepted subset, persist it as an accepted checkpoint, and keep
the task open. Ask one concise question about the unresolved part. If the requester
says “all topics” while only the current topic has been presented, confirm whether they
mean all points within the current topic rather than every undisclosed task.

## Rejection or revision

A rejected proposal is not a dismissed topic. Record the reason under Clarifications,
revise the proposal, and continue the same task. Dismiss only when the requester says
the decision topic itself is no longer needed.

## Status response

Keep status read-only and compact. For one Plan Ticket, report:

- ticket title and ID;
- completed, dismissed, and open counts;
- current topic;
- pending topic titles;
- legacy state, missing labels, blockers, or other consistency warnings;
- recommended next operation.

For inventory without an ID, report the validated plan count and one compact line per
Plan Ticket with title, ID, status, topic counts, and current topic. Separate
marker-only legacy plans and labeled candidates that fail marker validation. Never
select a plan for mutation on the requester's behalf.

## Plan Conclusion response

Present only the synthesis of accepted outcomes, material retained trade-offs,
deferred decisions, and resulting acceptance criteria or next-action boundaries. Ask
for review. Persist and complete only after explicit acceptance.
