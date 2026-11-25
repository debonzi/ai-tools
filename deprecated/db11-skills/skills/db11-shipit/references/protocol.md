# DB11 ShipIt protocol

## Purpose

DB11 ShipIt turns one accepted DB11 Plan into durable, technically planned and
executable delivery work. It preserves the Plan Ticket as the immutable functional and
decision baseline while allowing technical planning, task materialization, execution,
and delivery conclusion to occur in separate sessions.

The protocol is intentionally bounded. It does not revisit accepted product behavior,
authorize unrelated repository work, commit changes, deploy results, or act on remote
systems without separate explicit authorization.

## Lifecycle

```text
Accepted Plan Conclusion
  → Create Implementation Tickets
  → Accept each Technical Plan
  → Materialize Implementation Tasks
  → Execute tasks
  → Verify and conclude tickets
```

### Create Implementation Tickets

Derive one ticket per independently verifiable functional slice in the accepted Plan
Conclusion. Create a separate technical-enabler ticket only when shared work cannot be
owned coherently by one functional slice. Every ticket references the source Plan and
uses the same Initiative identity.

### Prepare a Technical Plan

Inspect relevant code and local or authorized public documentation. Persist codebase
findings, a recommended approach, interfaces, migrations, compatibility, verification,
risks, and a complete proposed task map in the selected Implementation Ticket. Resolve
material technical decisions with the requester, but do not reopen accepted functional
behavior.

### Accept and materialize

Technical-plan acceptance must be explicit and complete. Acceptance makes the plan a
normative execution input but does not itself authorize code changes. A separate
materialization operation creates the planned child tasks and genuine dependencies.

### Execute

Work exactly one open, unblocked Implementation Task. Follow the accepted technical
plan and repository instructions, preserve unrelated changes, verify the bounded
result, and persist a compact result before completing the task. Stop when new evidence
would require a functional or material architectural redesign.

### Verify and conclude

After all tasks are terminal, verify the ticket's acceptance criteria and record the
delivery result, deviations, tests, and remaining limitations. Complete the ticket only
through an explicit conclusion operation. Initiative completion is derived from all of
its Implementation Tickets; no root resource is completed.

## Implementation Ticket state machine

```text
Unplanned → In planning → Technical plan accepted → Ready
                 ▲                    │                 │
                 └──── explicit revision ───────────────┘
                                                      ↓
                                                Implementing
                                                      ↓
                                                   Delivered
```

All nonterminal states use an open Wyrd ticket. `Delivered` is persisted immediately
before completing the ticket. If accepted technical planning must change after task
materialization, an explicit planning operation reconciles the plan and still-open
tasks; completed task results remain historical evidence.

## Acceptance semantics

Explicit acceptance must identify the selected ticket's complete technical proposal or
its named acceptance points. Partial acceptance is persisted as a checkpoint while the
ticket remains `In planning`. Praise, clarification, or acceptance of only one choice
does not accept the whole Technical Plan.

Routine implementation details within accepted boundaries do not require requester
choice. Escalate decisions that materially affect architecture, public interfaces,
data integrity, security, migrations, operational risk, or accepted constraints.

## Recovery boundary

A fresh session can recover technical planning from:

- the completed Plan Ticket and accepted Plan Conclusion;
- the selected Implementation Ticket and its planning status;
- accepted technical decisions and proposed or materialized task map;
- codebase evidence referenced by the ticket.

Execution recovery additionally loads one complete task, active blockers, and only the
predecessor results needed by that task. Conversation history is never required.

## Functional gaps and deviations

Technical planning may clarify implementation feasibility but must not silently change
accepted behavior. If the Plan Conclusion is ambiguous or infeasible, persist the
blocker in the Implementation Ticket and report that a separate planning correction is
required.

During execution, bounded implementation variation may be recorded as a deviation when
it preserves the accepted outcome and technical constraints. A material redesign
requires explicit replanning before work continues.
