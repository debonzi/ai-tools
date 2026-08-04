# Guided discovery

Use this reference while a workflow is in discovery and its working spec is draft or suspended.

## Prepare before asking

1. Inspect the workflow and working-spec metadata with narrow DBZ Workflows reads.
2. Read the initial idea and only the spec sections relevant to the next uncertainty.
3. Inspect every applicable project instruction file plus enough architecture, conventions, and existing behavior to avoid repository-answerable questions.
4. Separate known facts, confirmed user decisions, agent proposals, and temporary assumptions. Never present an assumption as settled.
5. If setup, branch, phase, or revision validation fails, stop before asking product questions and report the prerequisite.

## One-question protocol

Ask exactly one concise question per turn. Prefix each question with an approximate index such as `(003/~018)`, where the first number is the current question and the second is the current estimate of total questions. Revise the estimate whenever answers expose or eliminate uncertainty.

Before a broad question, offer a concrete proposal whenever evidence supports one:

```text
(003/~018) Proposal: keep existing API clients compatible by adding the new
field as optional in V1. This reduces migration risk but delays strict
validation. Should we adopt that, or require all clients to migrate at launch?
```

The proposal is not a decision. State the recommendation and material trade-offs, then let the user decide. If the user answers several matters at once, record them, then ask only one next question.

## Incremental persistence

After each confirmed answer or small coherent group of confirmed facts:

1. Re-read the affected working-spec section and its current digest.
2. Update only those sections through `dbz_workflows_update_spec_sections` or the more specific supported coordinator operation.
3. Preserve the distinction between confirmed decisions and explicit assumptions in narrative text.
4. Re-inspect the artifact after mutation before continuing.
5. Record durable material decisions through the supported decision operation. Never hand-create a decision file or its metadata.

Do not wait until the end of a long conversation to persist confirmed information. Do not put tentative proposals into the spec as requirements.

A useful narrative checkpoint—not a machine artifact template—is:

```text
Confirmed: <what the decision owner selected>
Rationale: <why>
Assumptions still open: <bounded list or none>
Affected areas: <spec section names>
```

## Discovery coverage

Resolve each relevant area or record why it is not applicable:

- problem and desired outcome;
- users, actors, and decision owners;
- primary, alternate, failure, and recovery use cases;
- scope and non-scope;
- functional behavior and acceptance criteria;
- performance, reliability, accessibility, observability, and other non-functional needs;
- architecture and technical boundaries;
- internal and external integrations;
- data ownership, lifecycle, retention, and consistency;
- security, privacy, permissions, and abuse cases;
- migration, backward compatibility, and rollback;
- rollout, operations, support, and validation;
- dependencies, constraints, assumptions, and risks.

Do not mechanically ask about irrelevant areas. First inspect the project, propose a reasoned “not applicable,” and ask only when confirmation or a material decision is needed.

## Keep work local or create a ticket

Keep a lookup in the coordination session only when it is immediately answerable with bounded context. Create a discovery ticket when it needs a dedicated stakeholder, substantial or unavailable context, external or reusable evidence, parallel work, later resumption, or a result that informs multiple spec sections.

Choose the focused reference for research, question sessions, or design. Discovery research defaults to baseline-blocking. Any discovery-ticket wave must feed a synthesis ticket; its executors never edit the working spec directly.

## Ready for synthesis or approval

Discovery is not finished until important uncertainty is closed, required decisions are recorded, and the draft covers the applicable areas above. If discovery tickets existed, create synthesis only after its complete input wave can be declared as dependencies.

If no separate discovery tickets were needed, present a concise review of the complete draft and ask whether the user wants to approve the exact current spec as a baseline. Approval must use the separate reviewed baseline operation. “Looks good,” continuation, or permission to plan is not enough unless the user is explicitly confirming baseline approval.
