# DB11 ShipIt conversation format

Use the requester's language unless project instructions require another language for
conversation. Durable Wyrd bodies follow the project's documentation language.

## Start response

After validating the Plan and creating Implementation Tickets, report:

1. Initiative identity and source Plan title and ID;
2. compact accepted functional outcome and constraints;
3. ordered Implementation Ticket titles and IDs;
4. the first recommended `plan <implementation-ticket-id>` operation.

Do not inspect technical implementation details, expose raw commands, or imply that
ticket creation authorizes technical planning or implementation.

## Technical Plan presentation

```markdown
## <ticket-id> — <Implementation Ticket title>

<functional outcome and relevant accepted Plan inputs>

### Codebase findings

<bounded verified findings>

### Technical proposal

<recommended architecture, components, interfaces, data handling, and compatibility>

### Proposed Implementation Tasks

1. **<task title>:** <objective and functional coverage>.

### Verification

<tests and acceptance-criterion evidence>

### Alternatives and risks

- **Alternative or risk:** consequence.

### Points for acceptance

1. <material technical decision>
2. <task decomposition and ordering>
3. <verification or migration boundary>

<one direct acceptance or clarification question>
```

Persist clarifications and revisions in the ticket. Do not materialize child tasks
until the complete Technical Plan is explicitly accepted and a separate `materialize`
operation is requested.

## Resume and status

Report Initiative identity, source Plan, ticket counts by planning status, selected
ticket or task, active blockers, and exact next operation. Keep `resume` and `status`
read-only. Do not restate every accepted Plan Topic or completed task result.

## Work response

Report:

- selected task and parent ticket;
- bounded files or components changed;
- durable task result;
- verification performed and outcome;
- deviations or blockers;
- newly unblocked tasks;
- next operation.

Do not claim delivery completion merely because the last task completed.

## Conclusion response

Report acceptance-criterion evidence, delivered outcome, material deviations,
remaining limitations, completed ticket title and ID, and remaining Initiative tickets.
When all are terminal, report the Initiative as complete without creating or completing
a separate root resource.
