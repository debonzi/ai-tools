# Conclude and advance a phase

Use this operation only after an explicit request to conclude or advance the current
phase. Load the current phase reference and, when one exists, the next phase reference.

## Preconditions

Confirm from fresh Wyrd reads that:

- the current phase ticket is open and unblocked;
- exactly one open `kind:conclusion` task exists;
- that conclusion task is unblocked;
- every other phase task is terminal;
- the current phase completion gate is satisfied;
- no unresolved material blocker is hidden in a completed task result.

If a gate is not satisfied, leave the phase open and report the missing outcome. Do not
dismiss tasks or weaken the gate to force a transition.

## Synthesize the conclusion

Read only the task results needed to produce the phase output. Write a compact
conclusion into the current ticket's `Phase conclusion` section using the current
phase reference. Preserve references to detailed task titles and IDs when evidence may
need verification.

The conclusion must contain enough accepted context for the next phase without copying
raw exploration.

## Prepare the successor

The phase sequence is:

| Current | Successor |
| --- | --- |
| Definition | Planning |
| Planning | Implementation |
| Implementation | None in version 1 |

Before creating a successor, query all Journey tickets for its phase label. Reuse and
inspect an existing prepared successor after an interrupted transition; never create a
duplicate blindly.

For a new successor:

1. create its phase ticket with the same Journey label, the successor phase label, the
   stable destination, and the current phase conclusion in `Inputs`;
2. create only its concrete initial non-conclusion tasks;
3. create one conclusion task and make it depend on every other initial task;
4. make the successor ticket depend on the current ticket while both remain open;
5. edit the current ticket's `Next phase` section with the successor title and ID.

Re-read resources before each edit whose revision may have changed.

## Complete the transition

After the successor is fully prepared and blocked by the current ticket:

1. write the transition outcome into the conclusion task's `Result`;
2. complete the conclusion task with explicit noninteractive confirmation;
3. complete the current phase ticket;
4. verify the successor is now open and unblocked.

If any step fails, stop and report the exact partial state. On retry, inspect existing
resources and dependencies first; do not repeat successful creates or transitions.

## Finish Implementation

Implementation has no successor in version 1. Write its phase conclusion, record that
no later phase is modeled, complete the conclusion task, and complete the ticket. The
Journey is then terminal under the current protocol.

Do not invent Testing or Validation tickets. Those phases require a later protocol
decision.
