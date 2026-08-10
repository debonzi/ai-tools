---
name: db11-plan
description: Run an explicitly invoked, durable, topic-by-topic planning and decision session backed by one standalone Wyrd ticket. Use to research a problem, materialize its decision map, discuss one topic at a time, record clarifications and accepted decisions, resume without conversational history, and conclude with an accepted synthesis.
compatibility: Requires the wyrd executable from wyrd-cli 0.1.x on PATH.
disable-model-invocation: true
---

# DB11 Plan

DB11 Plan turns an open-ended problem into a durable sequence of researched proposals
and explicit requester decisions. The skill guides the conversation; one standalone
Plan Ticket and its Plan Topics hold the recoverable state.

## Guardrails

- Use Wyrd through `wyrd` as the only interface to tracking state. Never read or edit
  `.wyrd/` directly.
- Never run `wyrd init`. If no project exists, report that explicit initialization is
  required.
- Ignore unrelated Wyrd tickets. A DB11 Plan has no dependencies or relationships to
  other tickets unless the requester separately changes this protocol.
- `start` authorizes creation of the standalone Plan Ticket and its Plan Topics after the
  initial analysis. Other operations do not imply unrelated mutations.
- During an active discussion, persist only the current topic's actual clarifications
  and decisions. Complete a topic only after explicit requester acceptance.
- Do not infer acceptance from praise, a request for clarification, partial agreement,
  or silence. Ask when the scope of an apparent acceptance is ambiguous.
- Research discoverable context before asking the requester. Do not make material
  product or technical decisions on the requester's behalf.
- Do not implement the planned solution, modify production content, start a Journey,
  or delegate work to other agents unless separately and explicitly requested.
- Follow project instructions for the language of durable artifacts. Follow the
  requester's language in conversation when those instructions do not require
  otherwise.

## Load progressively

Classify the operation, then read the listed references completely and in order. Do
not preload every reference.

| Operation | References to load |
| --- | --- |
| Explain or review DB11 Plan | `references/protocol.md`, `references/conversation-format.md` |
| `start <problem>` | `references/wyrd-model.md`, `references/operations/start.md`, `references/operations/discuss.md`, `references/conversation-format.md` |
| `resume <ticket-id> [task-id]` | `references/wyrd-model.md`, `references/operations/resume.md`, `references/operations/discuss.md`, `references/conversation-format.md` |
| `status <ticket-id>` | `references/wyrd-model.md`, `references/operations/status.md` |
| Continue the current topic | `references/wyrd-model.md`, `references/operations/discuss.md`, `references/conversation-format.md` |
| `conclude <ticket-id>` | `references/wyrd-model.md`, `references/operations/conclude.md`, `references/conversation-format.md` |

If the operation is missing or ambiguous, ask which operation is intended. `start`
requires a problem statement. Every other operation requires the Plan Ticket ID.

## Durable model

- One open Plan Ticket represents the complete DB11 Plan.
- One child Wyrd task represents each material Plan Topic.
- Exactly one open Plan Topic is discussed at a time.
- Completed Plan Topics contain accepted decisions; dismissed topics are explicitly no
  longer needed; open topics remain pending or in discussion.
- The Plan Ticket keeps the objective, constraints, findings, topic map, compact
  decision log, and Plan Conclusion.
- No task dependencies are used: topic order is a conversational sequence, not an
  execution dependency graph.

Use the templates in `assets/ticket-body.md` and `assets/topic-task-body.md` as the
normative body structures.

## Context boundary

Retain only the target ticket, its accepted decision log, open topic summaries, the
single current topic, and evidence needed for that topic. Do not reload raw exploration
or every completed task unless a current decision requires verification.

## Reporting

Use titles before Wyrd IDs. Keep operational details out of the conversation. Report
the current topic, durable change, unresolved decision, and next action. Present a
researched recommendation and concrete acceptance points rather than an unstructured
questionnaire.
