---
name: dbz-spec
description: Guide discovery and draft temporary, implementation-ready specifications for new product initiatives or features. Use when Codex must turn an idea, brief, requirement, PRD, or feature request into a human-reviewable spec that will guide later implementation, including Portuguese requests such as "crie uma spec" or "especifique esta feature".
---

# DBZ Spec

Create a decision-complete, temporary implementation spec. Keep it readable by
humans and precise enough for a later agent to implement without deciding
product or technical behavior on its own.

## Discover

1. Read the request and every artifact or context supplied with it. Separate
   facts, constraints, and unknowns.
2. Begin with the brief. If it names concrete repository paths, documents, or
   interfaces that can resolve a material question, inspect them before asking
   about discoverable facts. If the goal or intended outcome is unclear, ask
   about that before exploring unrelated material.
3. Inspect repository instructions, relevant implementation paths, tests,
   schemas, and configuration only when they bear on the proposed work. Record
   evidence as facts; do not invent files, conventions, or existing behavior.
4. Research external sources only when an up-to-date or verifiable decision
   requires it. Prefer primary documentation and identify the source in the
   spec when it materially affects the design.

## Resolve decisions

- Ask concise questions for every unknown that changes scope, user behavior,
  interface contracts, compatibility, cost, security, operational risk, or
  the implementation approach. Do not close the spec or present a draft while
  one is unresolved. Keep asking questions one at time.
- Make and label only small, safe assumptions. Ask rather than assuming when a
  choice is high impact. Give a recommendation and its trade-off when it helps
  the requester decide.
- Record a decision, rationale, and rejected alternative only when the choice
  is non-obvious and would otherwise confuse a future implementer.
- For each such decision, ask whether it needs persistent repository
  documentation. If confirmed, add an implementation task naming the existing
  documentation convention or an agreed target and the minimum content to add.
  Do not create or change persistent documentation while producing the spec.
- Keep the temporary spec in the conversation by default. If a long-running
  conversation risks losing essential context, create a private checkpoint with
  `mktemp`, tell the requester its path, and remove it after the flow finishes.
  Never use a repository-tracked file for this checkpoint.

## Draft the spec

Present the result as `# Implementation Spec (Draft)` unless the active
environment requires a different wrapper or format. Omit irrelevant sections
instead of filling them with placeholders. Include these sections when useful:

1. **Context and known facts** — the problem, existing behavior, constraints,
   and evidence that informed the spec.
2. **Goal and success** — intended users, outcome, and measurable success when
   product work needs one.
3. **Scope and non-goals** — what changes and explicit boundaries.
4. **Behavior and requirements** — user flows, functional rules, and observable
   outcomes.
5. **Implementation design** — components, data flow, interfaces, API or event
   contracts, data changes, UX, migration, compatibility, security,
   observability, rollout, or performance only when applicable.
6. **Key decisions** — non-obvious decisions and their rationale.
7. **Acceptance and verification** — observable acceptance scenarios plus a
   test and verification strategy proportionate to the risk.
8. **Documentation tasks** — only when persistent documentation was approved.
9. **Minor assumptions** — assumptions that do not block implementation.

Use concrete wording, expected inputs and outputs, and explicit failure or edge
behavior where they matter. Never leave a high-impact question in a spec marked
ready for implementation.

## Review and handoff

After drafting, call out any minor assumptions and request human review. Revise
the same spec from the feedback. Mark it implementation-ready only after the
review resolves all material decisions. Do not begin implementation, write the
spec into the repository, or create persistent documentation unless the
requester separately asks for that work.
