# DB11 Plan protocol

## Purpose

DB11 Plan is a durable deliberation protocol for problems that benefit from initial
research, an explicit decision map, and requester acceptance one topic at a time. It
is useful for product, behavior, architecture, process, and other planning problems;
it is not limited to implementation specifications.

The protocol does not implement the planned outcome. The `db11-plan` skill interprets
the workflow, Wyrd stores its durable state, and later workflows may consume the final
conclusion only after separate authorization.

## Lifecycle

```text
Research → Materialize → Discuss topics → Synthesize → Conclude
```

### Research

Inspect referenced files, repository instructions, public documentation, existing
behavior, and other authorized sources. Separate requester-given constraints,
verifiable findings, hypotheses, and unresolved decisions.

### Materialize

Create one standalone Plan Ticket. Derive a sufficiently complete map of material
Plan Topics and create one child Wyrd task for each topic. Preserve the distinction
between accepted constraints and candidate direction.

### Discuss Plan Topics

Discuss exactly one open Plan Topic at a time. Present context, a recommendation,
alternatives, consequences, and concrete points for acceptance. Persist clarification
without treating it as acceptance. On explicit acceptance, record the normative
outcome, update the ticket decision log, complete the topic, and open the next topic.

### Synthesize

After every Plan Topic is terminal, combine accepted decisions into a concise Plan
Conclusion.
Do not copy raw exploration, rejected proposals, or conversation history unless needed
to explain a retained trade-off.

### Conclude

Ask the requester to review the synthesis. After explicit acceptance, persist the Plan
Conclusion in the Plan Ticket and complete the ticket. Producing files, implementation plans, Journey
phases, or code remains a separate request.

## Topic state machine

```text
not discussed ──► in discussion ──► accepted/completed
                         │
                         ├──► clarified/revised ──► in discussion
                         └──► explicitly obsolete/dismissed
```

Wyrd has no in-progress task status, so pending and in-discussion topics both remain
`open`; their body records the discussion state. The protocol's strict sequential
order makes the lowest-numbered open topic the default resume target.

A completed topic cannot be reopened in Wyrd 0.1.x. If a later accepted decision must
correct it, create a new correction topic, preserve the historical task, and append
the superseding decision to the ticket log.

## Acceptance semantics

Acceptance must refer clearly to the current proposal or named acceptance points.
Examples such as “accepted”, “I agree with all five points”, or an equally explicit
statement are sufficient. Praise, a clarification request, “looks promising”, or
agreement with only part of a proposal is not sufficient.

When acceptance is partial:

1. persist the accepted subset;
2. keep the task open;
3. state exactly what remains unresolved;
4. do not begin the next topic.

## Topic discovery and change

The initial topic map should cover every material uncertainty visible after research,
but it may evolve. Add a topic only when new evidence makes a distinct material
decision concrete. Before creating it, inspect existing open and terminal siblings to
avoid duplication and update the ticket's topic map after creation.

Do not silently merge independent decisions because they are technically related. Do
not split a topic merely to create more tracking detail.

## Recovery boundary

A fresh session can resume from:

- the ticket objective, constraints, findings, and decision log;
- open topic summaries in task-number order;
- the complete current task;
- evidence explicitly referenced by that task.

Conversation history is never required for correctness.
