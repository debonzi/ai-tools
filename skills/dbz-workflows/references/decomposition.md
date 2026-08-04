# Baseline decomposition

Use this reference only in planning with an active, explicitly approved baseline.

## Establish coverage

Read the current baseline and accepted decisions using narrow sections. List each required behavior, non-functional constraint, migration obligation, and acceptance criterion. Build a coverage map from each item to one or more proposed delivery or assurance tickets. Uncovered criteria block readiness.

Do not create delivery tickets against a draft, suspended, or stale baseline. Do not create implementation tickets while baseline-blocking research is open. Delivery research is allowed only for stable implementation detail and must be a dependency of tickets that need its result.

## Form session-sized outcomes

Each ticket must have one independently verifiable outcome that a fresh session can complete, ideally without compaction. Split when outcomes can be verified independently, unrelated subsystems are combined without atomic need, research/design uncertainty remains, a stable handoff is possible, or context is likely to exceed budget.

Do not split by arbitrary file count, line count, or hours. An atomic result may touch many files.

Use this content worksheet before creating each ticket:

```text
Outcome: <one verifiable result>
Baseline coverage: <specific requirement or criterion>
Boundary: <included work and explicit non-scope>
Inputs: <only required sections, decisions, prior results, and file paths>
Deliverables: <observable artifacts or behavior>
Acceptance evidence: <what proves completion>
Validation: <commands or inspections and expected result>
Handoff: <what dependents can rely on>
```

The core's current type template remains authoritative; this worksheet does not duplicate its schema. Supply every section requested by `dbz_workflows_create_ticket` and let the core allocate IDs, slugs, metadata, and the baseline reference.

## Build the DAG and execution policy

- Use dependencies only for real result ordering, not preferred scheduling order.
- Ensure every dependency exists and the graph is acyclic.
- A cancelled or superseded dependency requires explicit replanning; never auto-rewire it.
- Declare shared-file, subsystem, migration, and infrastructure conflicts.
- Mark mutating tickets parallel-safe only after checking isolation and integration risk.
- Keep question sessions, synthesis, and final verification exclusive.
- Treat readiness and staleness as derived values only.

Declare initial context narrowly: the ticket, required spec sections, accepted decisions, referenced ticket Results, and repository file paths. File contents are explored during execution rather than embedded. If the core reports the packet over budget, split the ticket. Record an exception only after explicit user approval with a concrete justification.

## Choose ticket purpose

Use the existing V1 ticket purpose that matches the outcome: implementation, documentation, delivery research, review, or verification. Do not invent custom types. Keep Git integration as a coordinator operation rather than a ticket.

Create tickets through `dbz_workflows_create_ticket`, then run `dbz_workflows_query_actionable` to validate the DAG, context, conflicts, and staleness. Correct draft contracts through supported operations; never hand-edit managed metadata.

## Planning review gate

Before declaring the workflow ready, verify:

- every baseline criterion has ticket coverage;
- every delivery ticket references the current baseline;
- contracts and validation evidence are concrete;
- dependencies and conflicts are valid;
- tickets meet the one-fresh-session policy or carry an approved context exception;
- execution, worktree, integration, review, and verification responsibilities are represented.

Present the coverage and DAG for review. Merely reaching ready or opening status does not dispatch work. Execution requires a separate explicit action and reviewed plan.
