# Project Glossary

This glossary is the canonical source for project terminology. Use its terms consistently when discussing relationships within or between repository components and when writing plans, documentation, user-facing text, code comments, or new identifiers. Established identifiers may retain legacy terminology when changing them would break compatibility.

## Initiative Model

### Initiative

A bounded development effort whose durable state begins with exactly one Plan Ticket and may, only after requester acceptance of its Plan Conclusion, extend to zero or more Implementation Tickets derived from that conclusion. All tickets in an Initiative share one stable Initiative identity for discovery and traceability.

An Initiative is a logical aggregate, not a Wyrd resource. Initiative membership does not establish parent-child relationships or imply execution dependencies between its tickets.

Use **Initiative** in prose and `initiative` in identifiers. An Initiative is not a Plan Ticket, Plan Topic, Implementation Ticket, implementation task, or dependency graph.

### Initiative Identity

The stable value that associates one Plan Ticket and its derived Implementation Tickets with the same Initiative. It supports discovery and traceability without replacing each resource's Wyrd ID or encoding execution order.

Use **Initiative identity** in prose and `initiative_identity` in identifiers.

### Implementation Ticket

A Wyrd ticket materialized from an accepted Plan Conclusion to deliver one bounded functional slice of its Initiative. It records the slice's expected behavior, relevant accepted decisions, scope, acceptance criteria, technical approach, and verification boundary. Its child tasks contain the technical work required to deliver that slice.

An Implementation Ticket references its source Plan Ticket and carries the same Initiative identity. It is not a child of the Plan Ticket, and it depends on another ticket only when execution genuinely requires that ordering.

Use **Implementation Ticket** in prose and `implementation_ticket` in identifiers.

### Implementation Task

One bounded unit of technical execution represented by a child Wyrd task under an Implementation Ticket. An Implementation Task implements part of its parent's accepted functional slice and records its durable result before completion. It is not a Plan Topic or a separate functional requirement.

Use **Implementation Task** in prose and `implementation_task` in identifiers.

## DB11 Plan Protocol

### DB11 Plan

A durable, topic-by-topic deliberation that researches one problem, materializes its material decisions in one Wyrd ticket, and records explicit requester acceptance without depending on conversational history. DB11 Plan produces an accepted planning conclusion but does not itself implement that conclusion, start a Journey, or delegate work to other agents. Materializing or executing implementation work requires separate explicit authorization.

Use **DB11 Plan** in prose and `db11-plan` for the skill and identifiers. A DB11 Plan is not a generic implementation plan, Pi session, Journey, or agent role.

### DB11 Plan Label

The canonical Wyrd label `protocol:db11_plan` applied to every new Plan Ticket and Plan Topic. It is the discovery index for DB11 Plan resources, while the Plan Ticket's protocol marker and the task's parent relationship validate their roles. The label does not replace the Plan Ticket ID as the durable resume identity.

Use **DB11 Plan label** in prose and `db11_plan_label` in identifiers.

### Plan Ticket

The Wyrd ticket that holds one DB11 Plan's objective, constraints, inspected sources, initial findings, topic map, compact decision log, and final Plan Conclusion. A Plan Ticket carries the DB11 Plan label and has no protocol-required dependencies. When it belongs to an Initiative, it also carries that Initiative's identity and serves as the accepted source for any derived Implementation Tickets; this association creates neither ticket hierarchy nor execution dependencies. Its Wyrd ID remains the durable resume identity for the DB11 Plan.

Use **Plan Ticket** in DB11 Plan prose and `plan_ticket` in identifiers.

### Plan Topic

One material decision in a DB11 Plan, represented by a child Wyrd task under the Plan Ticket and carrying the DB11 Plan label. A Plan Topic is discussed separately, may receive multiple clarifications or proposal revisions, and completes only after its accepted decisions are durably recorded. It is not an implementation task or dependency-ordered work item.

Use **Plan Topic** in DB11 Plan prose and `plan_topic` in identifiers.

### Plan Conclusion

The requester-accepted synthesis of a DB11 Plan's decisions, constraints, retained trade-offs, deferred decisions, and boundaries for subsequent work. It is persisted in the Plan Ticket before that ticket completes and excludes raw exploration and superseded proposals.

Use **Plan Conclusion** in DB11 Plan prose and `plan_conclusion` in identifiers.

## Journey Protocol

### Journey

A durable, multi-session development initiative conducted through the Journey Protocol. A Journey is identified in Wyrd by one stable `journey:<codename>` label, while its phase tickets, tasks, dependencies, and conclusions hold the state required to resume it without conversational history.

Use **Journey** in prose and `journey` in identifiers. A Journey is not an agent role, Pi session, ticket, or autonomous orchestrator.

### Destination

The accepted outcome that a Journey is intended to reach. The Destination defines what success means and bounds the Definition, Planning, and Implementation phases. It may be provisional during early Definition but must be stable before Planning begins.

Use **Destination** in Journey-specific prose and `destination` in identifiers.

### Journey Phase

One bounded stage of a Journey. Version 1 defines **Definition**, which decides what should exist and why; **Planning**, which decides how it should be implemented; and **Implementation**, which executes the accepted plan. Each Journey Phase has exactly one phase ticket and completes through a Phase Conclusion.

Use **Journey Phase** when the qualification is needed and **phase** when the Journey context is already clear. Use `phase` in identifiers.

### Phase Ticket

The Wyrd ticket that holds one Journey Phase's objective, inputs, completion gate, Phase Conclusion, and reference to its successor. Phase Tickets share the Journey label and use a `phase:<name>` label. Ticket dependencies form the phase chain; version 1 has no separate Journey root ticket.

Use **Phase Ticket** in prose and `phase_ticket` in identifiers.

### Phase Task

A Wyrd task containing one bounded unit of work required to close its parent Phase Ticket. A Phase Task never represents work reserved for a later Journey Phase. Research, questioning, decisions, prototypes, implementation, and phase conclusion are task kinds rather than Journey Phases.

Use **Phase Task** in prose and `phase_task` in identifiers.

### Phase Conclusion

The compact, durable output of a completed Journey Phase. It contains the accepted outcomes needed by the successor without copying raw exploration or depending on conversational history. A final `kind:conclusion` Phase Task synthesizes this output and prepares the next Phase Ticket when one exists.

Use **Phase Conclusion** in prose and `phase_conclusion` in identifiers.
