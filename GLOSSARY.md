# Project Glossary

This glossary is the canonical source for project terminology. Use its terms consistently when discussing relationships within or between repository components and when writing plans, documentation, user-facing text, code comments, or new identifiers. Established identifiers may retain legacy terminology when changing them would break compatibility.

## DB11 Crew

### Crewlead

The designated interactive Pi session at the center of a DB11 Crew. The term identifies the session's role, not the requester, a human operator, or a generic agent. It distinguishes this session from other sessions participating in the crew without prescribing its detailed behavior or responsibilities.

Use **Crewlead** as one word in prose and `crewlead` in identifiers. Avoid **crew lead**, **crew leader**, **crewleader**, **main session**, **primary session**, and **principal session** as names for this concept.

### Scout

A specialized, read-only crew member that performs a bounded reconnaissance or investigation for the Crewlead. A Scout may inspect workspace code and documentation on the current branch, whether the workspace is clean or dirty, and may research public web sources. Scouts may run in parallel and may use temporary worktrees or other isolated temporary state when necessary.

A Scout never implements a solution or modifies project content. Its report gives the Crewlead only the conclusions, essential verifiable evidence, uncertainties or gaps, relevant risks, and recommended next steps. Raw exploration, discarded paths, and information already condensed into the findings remain outside the Crewlead's context unless they are necessary to verify or use a finding.

Use **Scout** in prose and `scout` in identifiers.

### Planner

A specialized crew member that turns bounded instructions, Wyrd tickets, or Wyrd tasks into detailed implementation plans recorded as Wyrd tasks. A Planner may inspect project content but never changes that content, implements the solution, or starts a Builder. Its only project-state mutations are the ticket and task changes required to persist the plan.

A Planner defines the implementation scope, ordered steps, dependencies, constraints, validation, and acceptance criteria. It reports only a compact summary, task identifiers and ordering, and unresolved decisions to the Crewlead; operational detail remains in the tasks for a Builder to execute later.

A Builder follows the recorded plan without redesigning or expanding it. If the plan is unsafe, contradictory, stale, or infeasible, the Builder stops and reports the blocker instead of improvising or following it blindly.

Use **Planner** in prose and `planner` in identifiers.

### Builder

A specialized crew member that creates an implementation from a bounded Wyrd task or direct instruction received from the Crewlead. A Builder may modify project content and is responsible for validating the resulting implementation.

When given a planned task, a Builder follows it as recorded without redesigning it or expanding its scope. When given a direct instruction, it may make necessary local tactical decisions but may not expand the scope or make architectural decisions independently. It stops and reports a blocker when its input is unsafe, contradictory, stale, infeasible, or insufficient instead of improvising beyond these boundaries.

A Builder reports a compact implementation and validation outcome to the Crewlead; low-value execution detail remains outside the Crewlead's context.

Use **Builder** in prose and `builder` in identifiers. Avoid **worker** as the canonical name for this role; established compatibility-sensitive identifiers may retain it.

## Journey Protocol

### Journey

A durable, multi-session development initiative conducted through the Journey Protocol. A Journey is identified in Wyrd by one stable `journey:<codename>` label, while its phase tickets, tasks, dependencies, and conclusions hold the state required to resume it without conversational history.

Use **Journey** in prose and `journey` in identifiers. A Journey is not a DB11 Crew member, Pi session, ticket, or autonomous orchestrator.

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
