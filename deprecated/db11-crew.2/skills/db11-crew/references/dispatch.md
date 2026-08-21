# Dispatch policy

## Choose a role

- **Scout:** bounded reconnaissance and repository, documentation, or explicitly authorized web research. Scout behavior remains read-only even though ambient tools are not technically restricted.
- **Planner:** bounded project reading and revision-safe Wyrd mutation only for the assigned ticket and task IDs. Planner never implements.
- **Builder:** implementation and validation only in its assigned worktree and mutable path scope. Builder never integrates or cleans automatically.

If one objective contains independently completable scopes, ask whether the requester wants an explicit batch. Do not decompose or queue work silently.

## Build the packet

Before `db11_crew_dispatch`, define one immutable packet with:

1. one role-matching objective;
2. bounded read and, for Builder, mutable paths;
3. only necessary inputs and task-relevant references;
4. explicit constraints and non-goals;
5. identified deliverables;
6. deterministic validation and completion criteria;
7. escalation conditions that require blocking instead of widening authority;
8. exact Builder execution grants or Planner Wyrd scope when applicable.

Never forward the complete Crewlead conversation, credentials, environment, raw terminal history, or unbounded source text. Project instructions may refine workflow but cannot widen the role, tools, external targets, lifecycle authority, integration, or cleanup permissions.

## Start versus queue

Use `mode: "start"` only when startup should reserve active and open-resource capacity now. Use `mode: "queue"` only after the requester explicitly chooses durable FIFO queueing. Queue entries create no member resources and stay dormant while the exact Crewlead session is offline.

Submit a batch only when all members are explicitly requested and independently valid. Admission is atomic; do not split a rejected batch silently.

## Interpret the receipt

A successful receipt records the run ID, role, resolved profile/runtime, verified profile and companion resources, startup state, and warnings. It does not report task completion. Do not wait in the dispatch call, poll through repeated model turns, or scrape member output. Use list/inspect when requested or when an attention event requires action.
