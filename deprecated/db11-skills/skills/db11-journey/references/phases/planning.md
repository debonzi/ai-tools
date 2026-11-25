# Planning phase

Load this reference only for a ticket labeled `phase:planning`, when advancing from
Definition, or when advancing into Implementation.

## Purpose

Planning decides **how** to implement the accepted destination. It consumes the compact
Definition conclusion, resolves technical uncertainty, and produces bounded,
dependency-aware work suitable for implementation.

Planning does not deliver production implementation. A prototype is allowed only when
its Planning task explicitly defines it as disposable decision support.

## Allowed task kinds

- `kind:research`
- `kind:questioning`
- `kind:decision`
- `kind:prototype`
- `kind:conclusion`

Technical research establishes facts. Questioning and decision tasks settle material
choices with the requester. Prototype results record what was learned and whether the
artifact should be discarded or referenced; they do not silently become production
code.

## Required conclusion

The phase conclusion must contain:

```markdown
### Definition input

### Accepted technical decisions

### Architecture and interfaces

### Implementation workstreams

### Ordering and dependencies

### Constraints and migration considerations

### Builder-ready work

### Remaining blockers
```

`Builder-ready work` defines the title, objective, scope, inputs, constraints, expected
result, and dependencies for every Implementation task. It must reference accepted
technical decisions rather than restating their full exploration.

## Completion gate

Planning may advance when:

- every required technical choice is accepted;
- architecture, boundaries, and relevant interfaces are explicit;
- implementation work is bounded and ordered;
- dependencies can be represented among sibling Implementation tasks;
- each planned task has enough context to execute without redesign;
- material technical blockers are resolved;
- every non-conclusion Planning task is terminal.

## Implementation handoff

Create one Implementation task for each Builder-ready work item. Add sibling
dependencies in a second pass after all task IDs exist. Create the Implementation
conclusion task last and block it on every implementation work item.

A Planner may perform this structured handoff when explicitly delegated and when its
Wyrd mutation contract is available. Otherwise the coordinating session persists the
Planning conclusion and creates the Implementation tasks. Builders must not start
until the Planning phase ticket is complete and Implementation is unblocked.
