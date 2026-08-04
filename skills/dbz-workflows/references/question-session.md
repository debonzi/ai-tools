# Question-session tickets

Use a question session when a known stakeholder or decision owner must provide answers that repository inspection or research cannot supply.

## Define the session

Identify the stakeholder or role when known. For every planned question, explain why the answer matters, which decision or requirement it affects, and the consequence of leaving it unresolved. Group questions around one coherent decision boundary; split unrelated stakeholders or outcomes.

Create the ticket through `dbz_workflows_create_ticket` and let the core provide the canonical contract. Question sessions are manual, interactive, non-delegatable, and never scheduler-parallel.

A content worksheet is:

```text
Decision owner: <person or role>
Outcome needed: <bounded decision or information>
Question themes: <short ordered list>
Options already supported by evidence: <options and trade-offs>
Unresolved-answer policy: <why the ticket must remain incomplete>
```

This is narrative guidance, not machine metadata.

## Run interactively

Ask exactly one concise question per turn, with an adjustable index such as `(002/~006)`. Where possible, present concrete options, material trade-offs, and a recommendation before asking. Do not pressure the stakeholder to accept the recommendation.

After each answer:

1. restate the interpreted answer briefly;
2. ask for correction if it is ambiguous;
3. distinguish the stakeholder's decision from agent inference;
4. checkpoint through a supported canonical result/section operation when available;
5. ask only the next single question.

Example:

```text
(002/~006) Recommendation: retain existing sessions during migration and force
reauthentication only when token refresh fails. This lowers rollout risk but
keeps two token formats active temporarily. Should we use that policy?
```

Do not use direct file edits as a substitute for incremental checkpoints. If the current operation surface cannot safely checkpoint and context survival is at risk, return to coordination and report the blocker.

## Close or remain incomplete

Record the asked questions, confirmed answers, unresolved items, and resulting decisions. Required unanswered questions keep the ticket incomplete; submit `blocked` with the exact missing owner or answer rather than inventing a default.

Create or supersede durable decisions through the supported deterministic decision operation. Never hand-author decision metadata. A question-session executor reports proposed decision content; the coordinator applies canonical decision writes.

Question-session answers and decisions require human approval during result acceptance. Acceptance does not itself approve a spec baseline. The accepted result feeds synthesis, which reconciles it with other discovery evidence before the spec changes.
