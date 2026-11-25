# Conclude an Implementation Ticket

Use this operation only after an explicit request for one Implementation Ticket. The
request authorizes verification, durable delivery synthesis, and terminal completion
when every gate is satisfied.

## Preconditions

From fresh reads, require:

- an open, unblocked validated Implementation Ticket;
- planning status `Ready` or `Implementing`;
- every child task completed or explicitly dismissed;
- every completed task containing a non-placeholder Result;
- every dismissal recording why the work is no longer required;
- all functional acceptance criteria supported by durable verification evidence;
- no hidden functional, technical, migration, or operational blocker.

Read only task results needed to verify the gate. If any criterion lacks evidence or
requires requester validation, keep the ticket open and report the exact missing step.
Do not weaken criteria or dismiss work to force completion.

## Synthesize delivery

Write a compact Delivery result containing:

```markdown
### Delivered outcome

### Acceptance-criterion evidence

### Verification performed

### Technical-plan deviations

### Remaining limitations
```

Do not claim unverified behavior. Set planning status to `Delivered`, re-read the ticket,
and edit with its current revision before terminal transition.

## Complete and verify

Complete the ticket with explicit noninteractive confirmation, then re-read its terminal
state. If completion fails after the delivery edit, report the exact partial state and
do not repeat the accepted edit blindly.

Refresh all Initiative ticket summaries. Report the completed ticket, delivered result,
remaining open tickets, and recommended next operation. If every Initiative ticket is
terminal, report the Initiative as complete; do not create or complete a root resource.
