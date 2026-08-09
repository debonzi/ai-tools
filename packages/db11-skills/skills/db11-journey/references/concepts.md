# Journey protocol concepts

Read this reference only when explaining, reviewing, or changing the protocol itself.
Operational sessions should load their operation and phase references instead.

## Purpose

A Journey carries a development initiative across multiple sessions without depending
on conversational history. It separates definition, technical planning, and
implementation while allowing each phase to create the bounded work needed to close
itself.

The protocol is not an autonomous orchestrator or a DB11 Crew member. The
`db11-journey` skill interprets the protocol, Wyrd holds durable state, and DB11 Crew
may execute explicitly delegated work.

## Lifecycle

```text
Definition → Planning → Implementation
```

- **Definition** decides what should exist and why.
- **Planning** decides how the accepted destination will be implemented.
- **Implementation** executes the accepted plan.

Testing and validation are intentionally outside this first lifecycle. A later design
may add phases without redefining the first three.

## Phase chain instead of a root ticket

Version 1 has no separate Journey root ticket. Every phase is a Wyrd ticket carrying
the same `journey:<codename>` label and one `phase:<name>` label. Ticket dependencies
form the phase chain.

This keeps the model native to Wyrd:

- the shared Journey label finds the initiative;
- the phase label identifies each ticket's responsibility;
- the dependency graph identifies what can run now;
- child Wyrd tasks contain only work needed to close their own phase;
- each completed phase persists a compact conclusion for its successor.

## Phase transition

Every phase has one final conclusion task, blocked by its other open tasks. A
conclusion session:

1. synthesizes the durable phase conclusion;
2. prepares the next phase ticket and initial tasks;
3. makes the next phase depend on the current phase while both are active;
4. completes the conclusion task and current ticket;
5. leaves the next phase open and unblocked.

There may briefly be two open phase tickets during this transition, but only the
current one is unblocked.

## Context discipline

A current phase receives a compact predecessor conclusion, not the predecessor's full
history. Detailed task results remain available for verification on demand. Sessions
load the current phase and one selected task rather than the whole Journey.

A phase conclusion is a semantic compression boundary: accepted outcomes cross it;
raw discussion, discarded options, and superseded exploration do not.

## Responsibilities

- An initiating session may create Definition after an explicit request.
- A suitable session may resume the single open, unblocked phase.
- A Crewlead may coordinate a Journey but is not required for the protocol to exist.
- Scouts may perform explicitly delegated research.
- A Planner may turn accepted Planning conclusions into Builder-ready Implementation
  tasks.
- Builders may execute explicitly delegated Implementation tasks.

The Journey skill never treats an invocation as implicit authorization to create DB11
Crew members.
