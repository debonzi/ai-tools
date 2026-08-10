# Discuss a DB11 Plan topic

Use this operation for exactly one open topic under the explicitly identified DB11
Plan ticket.

## Select safely

1. Confirm the ticket is open and contains the protocol marker.
2. List open task summaries in task-number order.
3. Select the requester-named task, or the lowest-numbered open task.
4. View the complete selected task immediately before any edit.
5. Stop if another task is already marked `In discussion` and the requester has not
   explicitly chosen to reorder topics.

If a pending task becomes current, research its discoverable evidence, fill its
proposal and acceptance sections, change Discussion status to `In discussion`, and
edit with the current revision before presenting it.

## Present a proposal

Use the standard topic format. Distinguish:

- already accepted constraints;
- evidence relevant to this topic;
- the recommended normative proposal;
- materially distinct alternatives and consequences;
- concrete points whose acceptance would close the topic;
- decisions intentionally deferred to named later topics.

Do not overwhelm the requester with raw exploration or ask multiple unrelated
questions.

## Handle clarification

A clarification request authorizes a durable checkpoint in the current topic but not
completion:

1. answer the specific uncertainty;
2. add the clarification and refined normative wording to the task;
3. keep Discussion status `In discussion`;
4. leave Accepted decisions unchanged except for subsets already explicitly accepted;
5. re-read and use `--expected-revision` for the edit;
6. ask whether the clarified proposal is accepted.

## Handle acceptance

First determine whether acceptance covers every current acceptance point. If it is
partial or ambiguous, persist the accepted subset and keep the task open.

For complete explicit acceptance:

1. re-read the task;
2. replace conversational proposal text only as needed to make Accepted decisions a
   complete normative record;
3. set Discussion status to `Accepted by the requester`;
4. edit the task with its current revision;
5. re-read the ticket and append one compact decision-log entry with the topic title
   and accepted outcome;
6. edit the ticket with its current revision;
7. complete the task with `--yes --json`;
8. refresh open task summaries.

Do not complete before both accepted records are durable.

## Move to the next topic

If another open topic exists, select the lowest-numbered one, research only its bounded
scope, persist its initial proposal as `In discussion`, and present it in the same
response that confirms the previous topic's completion.

If no open topic exists, report that synthesis is ready. Do not synthesize or complete
the ticket until the requester explicitly invokes or requests conclusion.

## Add or retire topics

Create a new topic only when a distinct material decision becomes concrete and no
existing sibling covers it. Update the ticket topic map immediately after creation.

Dismiss a topic only after explicit requester agreement that the topic itself is no
longer needed. Persist the reason in Accepted decisions or Clarifications, add a
compact ticket decision-log entry, then dismiss with `--yes --json`. Rejection of one
proposal is not grounds for dismissal.
