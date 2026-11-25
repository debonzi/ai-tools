# Inspect DB11 ShipIt status

Status is strictly read-only. With a Plan Ticket ID it reports one Initiative; without
an ID it inventories validated DB11 ShipIt Initiatives.

## Inspect one Initiative

1. Run `wyrd status --json`.
2. View and validate the explicit completed Plan Ticket.
3. Derive its Initiative identity.
4. List all tickets with `protocol:db11_shipit` and the identity text using
   `--status all --summary --json`.
5. Validate complete bodies before membership classification.
6. List child task summaries only for open selected tickets or when counts are needed.

Report:

- Initiative identity and source Plan;
- Implementation Ticket counts by `Unplanned`, `In planning`, `Technical plan
  accepted`, `Ready`, `Implementing`, and `Delivered`;
- open, completed, and dismissed ticket counts;
- current planning target, executable tasks, and blocked work;
- inconsistent labels, markers, identities, source references, task maps, or results;
- whether the Initiative is complete;
- recommended next operation.

## Inventory Initiatives

Without an ID:

1. list open `protocol:db11_shipit` ticket summaries;
2. include terminal tickets only when the requester asks for completed, historical, or
   all Initiatives;
3. validate candidate bodies and group by exact Initiative identity;
4. validate each group's source Plan Ticket;
5. calculate compact ticket-state counts without loading every task body.

Report one line per validated Initiative with source Plan title and ID, ticket counts,
current state, blocker summary, and explicit Plan Ticket ID required for resume. Report
labeled candidates with invalid markers or identities separately. Do not guess group
membership, activate planning, add labels, or repair state.
