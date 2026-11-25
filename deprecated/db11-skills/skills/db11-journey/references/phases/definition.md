# Definition phase

Load this reference only for a ticket labeled `phase:definition` or when advancing
into Planning.

## Purpose

Definition decides **what** the Journey should achieve and **why**. Discovery is an
activity within this phase, not a separate phase: research, questioning, and explicit
product or behavior decisions refine the initial macro idea into an accepted
destination.

Definition does not choose frameworks, languages, architecture, or implementation
steps unless one is already an immutable input constraint.

## Allowed task kinds

- `kind:research`
- `kind:questioning`
- `kind:decision`
- `kind:conclusion`

Research may inspect project context or public sources. Questioning owns decisions that
only the requester can make. A task should resolve one bounded Definition outcome.

## Required conclusion

The phase conclusion must contain:

```markdown
### Accepted destination

### Problem or opportunity

### Expected outcomes

### In scope

### Out of scope

### Constraints

### Functional workstreams

### Open technical questions for Planning
```

Functional workstreams describe high-level capabilities or outcomes, not technical
implementation tasks. Open technical questions are deliberate Planning inputs, not
unfinished Definition work.

## Completion gate

Definition may advance when:

- the macro idea and motivation are understood;
- the destination is accepted and specific enough to plan;
- expected outcomes and scope boundaries are explicit;
- known nontechnical constraints are recorded;
- high-level functional workstreams identify what must exist;
- material product and behavior questions are resolved;
- remaining open questions are genuinely technical Planning concerns;
- every non-conclusion Definition task is terminal.

## Planning handoff

Create Planning tasks from concrete technical questions, research needs, architecture
or technology decisions, and prototype needs exposed by the Definition conclusion.
Do not create Implementation tasks during this handoff.

A Crewlead may coordinate questioning and accept research results. Scouts may perform
explicitly delegated research. Neither is required for a non-crew session to complete
Definition.
