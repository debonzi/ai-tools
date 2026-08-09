# Implementation phase

Load this reference only for a ticket labeled `phase:implementation` or when advancing
from Planning.

## Purpose

Implementation executes the accepted Planning conclusion. Its tasks produce the
planned changes without expanding scope or making material product, architecture, or
technology decisions independently.

Testing and validation are not separate Journey phases in version 1. This reference
does not define their future lifecycle.

## Allowed task kinds

- `kind:implementation`
- `kind:research` only for a bounded fact required by an implementation task
- `kind:questioning` only for a material blocker that cannot be answered from accepted
  decisions
- `kind:conclusion`

Implementation research and questioning unblock execution; they do not reopen the
entire Planning scope. If an answer would materially redesign the accepted plan, stop
and report the protocol gap rather than improvising a new architecture.

## Implementation task contract

Each implementation task must identify:

- the bounded objective and paths or components in scope;
- accepted decision and predecessor-task inputs;
- ordering dependencies;
- constraints and prohibited scope expansion;
- the expected implementation result;
- the durable result to record before completion.

A Builder follows this contract when explicitly delegated. Direct work by the current
session follows the same boundary.

## Required conclusion

The phase conclusion must contain:

```markdown
### Implemented work

### Plan deviations

### Unresolved blockers

### Resulting project state

### Journey outcome
```

Do not claim outcomes that were not established by the completed task results.

## Completion gate

Implementation may conclude when:

- every planned implementation task is terminal;
- delivered results and intentional omissions are recorded;
- deviations from Planning are explicit;
- no unresolved blocker is hidden as completed work;
- the Journey outcome is summarized against the accepted destination.

Implementation is terminal in version 1. Complete its conclusion task and phase ticket
without creating a successor. Do not infer Testing or Validation phases.
