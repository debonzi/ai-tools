# Start a Journey

Use this operation only after an explicit request to start a Journey.

## Establish the minimum input

Obtain or derive without guessing:

- a human-readable Journey name;
- a valid codename;
- the initial macro idea;
- a provisional destination statement.

Definition exists to refine these inputs, so do not require technical decisions or a
complete specification before creating it. Ask one concise question when a missing
value prevents safe creation.

## Check state

1. Run `wyrd status --json`.
2. If no Wyrd project exists, stop and ask for explicit initialization.
3. Query all tickets with the proposed `journey:<codename>` label using `--status all
   --summary --json`.
4. If any exist, do not create a duplicate Journey. Report its state and offer the
   resume operation.

## Create Definition

Create one ticket titled `Define <Journey name>` with:

- `journey:<codename>`;
- `phase:definition`;
- the phase-ticket body from the Wyrd model;
- the initial idea in `Inputs`;
- the destination marked provisional when it has not been accepted;
- the Definition completion gate from the phase reference.

## Seed phase work

Create only tasks needed to close Definition. Typical initial tasks are:

- bounded research into discoverable context;
- questioning needed to define destination, scope, constraints, or expected outcomes;
- explicit product or behavior decisions;
- one conclusion task.

Do not create Planning or Implementation tasks. Do not force every foreseeable
Definition question into the initial list; new phase work may be added when discovery
makes it concrete.

Create all initial non-conclusion tasks first. Create the conclusion task last, then
add each non-conclusion task as its blocker in a second pass.

## Finish the start operation

Re-read the ticket and open task summaries. Report:

- the Journey label;
- the Definition ticket title and ID;
- the initial tasks in dependency order;
- which task is currently takeable;
- unresolved input that requires the requester.

Do not begin delegated research or advance the phase unless separately requested.
