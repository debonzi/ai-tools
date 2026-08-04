# Design tickets

Use a design ticket when a bounded technical decision needs alternatives, repository evidence, and explicit consequences before the working spec can close.

## Bound the design

Define one decision to be made, constraints inherited from the draft and accepted decisions, interfaces affected, and the evidence required to compare alternatives. Do not hide research inside design; create a research dependency when feasibility or external behavior is still unknown.

Use `dbz_workflows_create_ticket` so the core applies the current design contract and validates dependencies and context. A design proposal may be delegated, but any decision marked human-required still needs the decision owner's approval.

Content worksheet:

```text
Decision: <one bounded technical choice>
Forces: <constraints and quality attributes>
Alternatives: <at least viable options, including status quo when relevant>
Comparison: <trade-offs using the same criteria>
Recommendation: <choice and rationale>
Consequences: <positive, negative, migration, and follow-up effects>
```

This is an authoring aid, not a machine schema.

## Evaluate alternatives

Inspect existing architecture and conventions before proposing change. Compare viable options consistently across correctness, complexity, compatibility, security, operations, migration, reversibility, and validation. Reject an option only with evidence or a clearly stated constraint.

Keep the recommendation separate from an accepted decision. Record assumptions and identify what evidence would invalidate the recommendation.

Example summary:

```text
Recommendation: extend the existing event pipeline rather than add a second
queue. It preserves ordering and observability conventions. The trade-off is
shared backpressure, which requires a new saturation test and alert threshold.
```

## Handoff and synthesis

Submit alternatives, recommendation, rationale, consequences, unresolved matters, and affected spec sections in the normalized result. The design executor does not implement code and does not directly edit the spec.

The coordinator accepts the result, records any durable decision through the supported decision operation, and includes the design ticket in the dependent synthesis wave. Synthesis updates decisions before dependent spec text. If no alternative can satisfy the constraints, return `blocked` with the conflicting constraints rather than choosing silently.
