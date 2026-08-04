# Continue a workflow

Continuation reconstructs the next safe action from canonical artifacts. It never depends on a previous Pi transcript.

## Re-establish state

1. Use `/dbz-workflows continue [workflow-id]` or select a workflow explicitly when more than one is available.
2. Validate project identity, active storage, workflow branch expectations, and canonical artifact revisions.
3. Inspect workflow and ticket metadata with `dbz_workflows_inspect`.
4. Read only the selected sections needed to understand the current blocker or next gate.
5. Query `dbz_workflows_query_actionable` when ticket readiness matters.

Do not switch workflow identity based on a changed path or locator. Do not silently repair an invalid manifest. In project storage mode, canonical changes and mutating-ticket dispatch also require the expected clean workflow checkout.

A concise continuation summary can use:

```text
Workflow and phase: <ID, title, phase, conditions>
Current baseline: <ID or none; active, draft, or suspended>
Open discovery blockers: <IDs or none>
Active claims/results: <IDs and required coordinator action>
Actionable tickets: <derived IDs or none>
Next safe action: <one explicit action>
```

This is a status summary, not persisted metadata.

## Route by phase

- **Discovery:** resume the next unanswered discovery question, complete a focused discovery ticket, or synthesize a completed input wave. Load the corresponding reference.
- **Planning:** continue baseline coverage and decomposition. Do not dispatch tickets.
- **Ready:** show the proposed execution action; require explicit execution before any claim or session starts.
- **Execution:** derive actionable tickets, display the reviewed plan, and run only explicitly selected tickets through `/dbz-workflows run [ticket-id]`.
- **Verification:** use `/dbz-workflows verify [workflow-id]` and follow the guarded verification/integration flow available in the extension. Do not equate “ready to merge” with completion.
- **Completed or cancelled:** report terminal state; do not reopen it in V1. New work uses a new workflow or an explicit supported baseline revision before terminal state.

## Claims and dedicated sessions

A claim never expires automatically. Resume the recorded dedicated session when it exists. If it is missing, use explicit claim recovery with the exact claim identity and a recorded reason; never release it merely because time passed.

Executors submit exactly one normalized `done`, `blocked`, or `failed` result. They cannot accept or complete their own tickets. Return to coordination, inspect canonical Result evidence, integrate mutating work through reviewed Git plans, and accept only after deliverables, criteria, validation, and final integrated commits are verified.

Dashboards, status reads, and wave planning do not dispatch work.

## Scope change or new evidence

If planning exposes baseline-changing uncertainty, return explicitly to discovery. If execution or verification reveals a change to scope, architecture, behavior, or acceptance criteria, suspend the active baseline through the guarded revision operation, stop affected tickets from being treated as actionable, and create the focused discovery/synthesis work needed for a new baseline.

Preserve completed work as history. Retain, revise, cancel, or supersede affected tickets explicitly after the new baseline; never delete or silently reinterpret them.

## Lost context or blocked operations

If a referenced session is gone, rely on canonical artifacts and create a fresh supported session after explicit recovery. If a required command or mutation tool is unavailable, report the missing deterministic capability and stop. Never substitute direct canonical edits, internal module imports, or transcript reconstruction.
