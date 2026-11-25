# Start DB11 ShipIt

Use this operation only after an explicit
`/skill:db11-shipit start <plan-ticket-id>` invocation. It authorizes creation of the
Implementation Tickets derived from that Plan, but not child-task creation or
production changes.

## Validate the source

1. Run `wyrd status --json`.
2. View only the explicit Plan Ticket.
3. Require terminal status `completed`, `Protocol: DB11 Plan`, and a non-placeholder
   Plan Conclusion with explicit requester acceptance recorded in the decision log.
4. Read terminal Plan Topic bodies only when the conclusion is insufficient to preserve
   exact accepted behavior.
5. Derive the Initiative identity as `plan:<plan-ticket-id>`.

A dismissed Plan, an open Plan, or an unaccepted conclusion cannot start DB11 ShipIt.
Do not edit the terminal Plan Ticket.

## Prevent duplicates

Query all tickets carrying `protocol:db11_shipit` and the Initiative identity text.
Validate complete candidate bodies. If any valid member exists, do not create another
set; report the existing Initiative and offer `resume`.

A labeled candidate without the DB11 ShipIt marker is an inconsistency, not an
Initiative member. Stop rather than reuse or mutate it.

## Derive functional slices

Create one proposed Implementation Ticket per independently verifiable functional
outcome in the accepted Plan Conclusion. Keep related frontend, backend, persistence,
and tests in one slice when together they deliver one outcome. Create a separate
technical-enabler ticket only when shared work cannot be owned coherently by one slice.

Each proposal must have:

- functional outcome;
- accepted Plan inputs;
- in-scope and out-of-scope boundaries;
- observable acceptance criteria;
- known ordering against other slices.

Do not invent behavior omitted from the accepted Plan. If the conclusion does not
support a complete decomposition, present the proposed slices and obtain explicit
requester acceptance before creating tickets. A new behavioral decision requires a
separate planning correction rather than an assumption in ShipIt.

## Create Implementation Tickets

Build every body from `../../assets/implementation-ticket-body.md`, set
`Status: Unplanned`, and add `protocol:db11_shipit` at creation.

Do not add ticket dependencies during `start`; record accepted known ordering in the
relevant ticket bodies for later materialization. Never add a dependency to the source
Plan Ticket. If creation fails partway, stop and report exact resources; never repeat
successful creates blindly.

Do not create Implementation Tasks, inspect implementation details, or prepare a
Technical Plan during `start`.

## Verify and report

Re-read all created ticket summaries and validate complete bodies as needed. Verify
shared Initiative identity, canonical labels, unique slices, `Unplanned` status, and no
child tasks.

Report the source Plan, Initiative identity, ordered ticket list, accepted functional
baseline, and the exact next operation: `plan <first-implementation-ticket-id>`. Do not
materialize tasks or modify production content.
