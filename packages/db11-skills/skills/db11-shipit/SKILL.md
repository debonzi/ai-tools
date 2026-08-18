---
name: db11-shipit
description: Continue an accepted DB11 Plan as a durable Initiative backed by Wyrd. Use when explicitly asked to create Implementation Tickets from a completed Plan Ticket, prepare or resume technical planning, materialize executable Implementation Tasks, inspect Initiative status, execute one accepted task, or conclude delivered work across isolated sessions.
compatibility: Requires the wyrd executable from wyrd-cli 0.1.x on PATH.
disable-model-invocation: true
---

# DB11 ShipIt

DB11 ShipIt carries an accepted DB11 Plan into bounded technical planning and
implementation without depending on conversational history. The completed Plan Ticket
remains the immutable decision source; Implementation Tickets and their child tasks
hold the recoverable delivery state.

## Guardrails

- Use Wyrd through `wyrd` as the only interface to tracking state.
  Never read or edit `.wyrd/` directly.
- Never run `wyrd init`. If no project exists, report that explicit initialization is
  required.
- Treat the source Plan Ticket as read-only. It must be completed, contain
  `Protocol: DB11 Plan`, and hold an explicitly accepted Plan Conclusion.
- `start` authorizes only the Initiative's Implementation Ticket creation. `plan`
  authorizes read-only codebase research and durable technical-plan edits.
  `materialize` authorizes task and dependency creation. Only `work` authorizes the
  bounded production changes of its selected Implementation Task.
- Do not infer technical-plan acceptance from praise, partial agreement, clarification,
  or silence. Materialize tasks only after explicit acceptance.
- Never change accepted functional behavior during technical planning or execution.
  Report a functional gap instead of silently redesigning it.
- Preserve unrelated worktree changes. Do not commit, push, deploy, mutate remote
  services, or delegate work unless separately and explicitly requested.
- Do not complete an Implementation Ticket automatically when its last task completes.
  Completion requires an explicit `conclude` operation and a satisfied delivery gate.
- Follow project instructions for durable artifact language and code quality.

## Load progressively

Classify the operation, then read the listed references completely and in order.
Do not preload every reference.

| Operation | References to load |
| --- | --- |
| Explain or review DB11 ShipIt | `references/protocol.md`, `references/conversation-format.md` |
| `start <plan-ticket-id>` | `references/wyrd-model.md`, `references/operations/start.md`, `references/conversation-format.md` |
| `resume <plan-ticket-id> [ticket-id\|task-id]` | `references/wyrd-model.md`, `references/operations/resume.md`, `references/conversation-format.md` |
| `status [plan-ticket-id]` | `references/wyrd-model.md`, `references/operations/status.md` |
| `plan <implementation-ticket-id>` | `references/wyrd-model.md`, `references/operations/plan.md`, `references/conversation-format.md` |
| `materialize <implementation-ticket-id>` | `references/wyrd-model.md`, `references/operations/materialize.md` |
| `work <implementation-task-id>` | `references/wyrd-model.md`, `references/operations/work.md` |
| `conclude <implementation-ticket-id>` | `references/wyrd-model.md`, `references/operations/conclude.md` |

`start` requires the completed Plan Ticket ID. `resume` and Initiative-specific `status`
use that same ID as the stable Initiative identity. Other mutating operations require
an explicit Implementation Ticket or Implementation Task ID. For a missing or
ambiguous operation, ask which operation is intended.

## Durable model

- The Initiative identity is `plan:<plan-ticket-id>`.
- Exactly one completed Plan Ticket is the accepted decision source.
- Zero or more top-level Implementation Tickets carry `protocol:db11_shipit`, contain
  `Protocol: DB11 ShipIt`, and reference the source Plan Ticket.
- One Implementation Ticket represents one bounded functional slice or indispensable
  technical enabler. It stores both the accepted technical plan and delivery result.
- Child Implementation Tasks are created only from an accepted technical plan. They
  carry `protocol:db11_shipit` and `kind:implementation`.
- Initiative membership creates no hierarchy or dependency between tickets. Add ticket
  or sibling-task dependencies only for genuine execution ordering.
- The Initiative is complete when every Implementation Ticket is terminal; there is no
  separate Initiative root resource to complete.

Use the templates in `assets/implementation-ticket-body.md` and
`assets/implementation-task-body.md` as normative body structures.

## Context boundary

For technical planning, retain the Plan Conclusion, the selected Implementation Ticket,
and only codebase evidence needed for that slice. For execution, retain the selected
ticket, one task, active blockers, accepted technical inputs, relevant predecessor
results, and necessary source files. Do not reload every Plan Topic or sibling task.

## Reporting

Use titles before Wyrd IDs. Keep raw commands and discarded exploration out of the
conversation. Report the Initiative identity, selected ticket or task, durable state
change, verification, blockers, and exact next operation.
