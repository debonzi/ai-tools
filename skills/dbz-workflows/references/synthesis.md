# Synthesis

Synthesis is the exclusive discovery writer that reconciles completed discovery-ticket results into decisions and selected working-spec sections.

## Gate the synthesis wave

Before starting, verify that the synthesis ticket:

- depends on every research, question-session, design, and earlier synthesis input in the current wave;
- receives only completed and coordinator-accepted inputs;
- has no question session with required unresolved answers;
- is the only canonical writer active for discovery; and
- can identify every section and decision potentially affected.

Read only input Result sections, referenced decisions, and affected spec sections. Do not load whole workflows or prior transcripts when narrow reads suffice.

## Reconcile before writing

Build a reconciliation view such as:

```text
Finding | Source ticket | Confidence/authority | Affected decision/section | Resolution
```

For contradictions, prefer neither recency nor confidence blindly. Compare source authority, versions, assumptions, and user decisions. If evidence cannot be reconciled, create or retain an explicit blocker and another focused discovery ticket. Never bury conflict in prose.

Apply changes in this order:

1. validate all canonical input dependencies and their accepted results;
2. create or supersede accepted decision artifacts through the supported deterministic operation;
3. update only dependent working-spec sections;
4. record remaining blocker ticket IDs;
5. report each changed section and why.

Use the supported synthesis operation backed by the deterministic core's synthesis validation. Do not simulate synthesis with direct file edits. `dbz_workflows_update_spec_sections` alone must not be used to bypass dependency validation, decision ordering, exclusive-write rules, or blocker recording.

## Result quality

The synthesis result must state:

- input ticket IDs considered;
- contradictions and their resolution;
- decisions created, retained, or superseded;
- spec sections changed and the reason for each;
- remaining blockers and the next discovery wave, if any;
- whether the draft appears ready for user review.

Example section report:

```text
Security — added PKCE and token-rotation requirements from T-0002 and D-0003;
removed the implicit-flow assumption contradicted by T-0001.
```

Synthesis never implements project changes and never creates a baseline.

## Separate baseline approval

After synthesis is accepted and all blockers are closed, present the exact current draft for review. Baseline approval remains a separate, explicit user action: ask whether the user approves that revision as the new immutable baseline. Approval must use a separately generated, reviewed baseline plan and its guarded apply operation.

Do not infer approval from “continue,” “start planning,” ticket acceptance, or silence. If approval is declined, return to discovery and persist the requested draft revisions through supported operations. Implementation-ticket creation remains prohibited until a baseline is active, and it is always prohibited while baseline-blocking research remains open.
