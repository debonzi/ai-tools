# Conclude a DB11 Plan

Use this operation only after an explicit request to conclude the named ticket. The
initial conclusion request authorizes synthesis and presentation, not terminal
completion before requester review.

## Preconditions

From fresh Wyrd reads, confirm:

- the ticket is open and contains `Protocol: DB11 Plan`;
- the ticket and topics have the canonical label, or any missing labels are accounted
  for and reported as legacy or consistency warnings;
- every Plan Topic task is completed or explicitly dismissed;
- every completed topic has normative Accepted decisions;
- every terminal topic has a corresponding ticket decision-log entry;
- no unresolved material blocker or acceptance point remains;
- no unexpected dependency or relationship changes the standalone scope.

The label alone never satisfies the protocol-marker check. Do not repair missing labels
as part of conclusion, and do not exclude unlabeled legacy topics from the completion
gate.

If any topic remains open, report it and resume discussion instead of weakening the
completion gate.

## Synthesize

Use the ticket constraints and decision log first. Read completed topic bodies only
when needed to preserve exact semantics, retained trade-offs, deferred decisions,
acceptance criteria, or evidence references.

Produce a concise Plan Conclusion that contains:

- the accepted outcome or direction;
- the decisions that materially define it;
- retained constraints and non-goals;
- important trade-offs and risks;
- deliberately deferred decisions and their destination;
- acceptance criteria or boundaries for whatever workflow follows.

Exclude raw exploration, superseded proposals, conversational acknowledgements, and
implementation detail that was never accepted.

Present the synthesis and ask for explicit review. Keep the ticket open while the
requester requests clarification or revisions. Persist an interim conclusion
checkpoint only when useful for multi-session recovery, clearly marking it unaccepted.

## Accept and complete

After explicit acceptance:

1. re-read the ticket and verify that no topic reopened or appeared;
2. replace the Plan Conclusion placeholder with the accepted synthesis;
3. append a decision-log entry stating that the conclusion was accepted;
4. edit with the current revision;
5. complete the ticket with `--yes --json`;
6. re-read the terminal ticket to verify the transition.

Report the final ticket title and ID, the compact conclusion, deferred work, and the
fact that implementation, file creation, Journey creation, or Crew delegation still
requires separate authorization.

If completion fails, report the exact partial state and do not repeat successful edits
blindly.
