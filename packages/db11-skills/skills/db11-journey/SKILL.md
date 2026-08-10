---
name: db11-journey
description: Run durable, multi-session development initiatives as staged Wyrd tickets for definition, planning, and implementation. Use when the requester explicitly asks to start, resume, inspect, work on, or advance a Journey.
compatibility: Requires the wyrd executable from wyrd-cli 0.1.x on PATH.
---

# DB11 Journey

A Journey is a durable initiative whose state lives in Wyrd rather than in a Pi
session. The skill guides the protocol; Wyrd stores its phase tickets, phase tasks,
dependencies, conclusions, and progress.

## Guardrails

- Use `wyrd` as the only interface to tracking state. Never read or edit `.wyrd/`.
- Use `--json` for agent-facing Wyrd commands and `--summary` for discovery.
- Do not run `wyrd init`. If no Wyrd project exists, ask for explicit initialization.
- Do not mutate Wyrd when the requester asks only for an explanation, review, or
  proposal.
- Start or advance a Journey only when the requester explicitly asks for that
  transition.
- Never delegate work to other agents automatically. Delegation requires a separate,
  explicit request and an available delegation mechanism.
- Keep Definition and Planning free of production implementation. Keep
  Implementation within the accepted plan and report material uncertainty instead of
  silently redesigning it.

## Load progressively

First classify the request. Then read only the listed references, completely and in
order. Do not preload every reference.

| Operation | References to load |
| --- | --- |
| Explain or review the protocol | `references/concepts.md` |
| Start a Journey | `references/wyrd-model.md`, `references/operations/start.md`, `references/phases/definition.md` |
| Resume or inspect a Journey | `references/operations/resume.md`, then only the current phase reference |
| Work on a phase task | `references/wyrd-model.md`, `references/operations/work.md`, then only the current phase reference |
| Conclude or advance a phase | `references/wyrd-model.md`, `references/operations/advance.md`, then the current and next phase references |

Phase labels select the phase reference:

- `phase:definition` → `references/phases/definition.md`
- `phase:planning` → `references/phases/planning.md`
- `phase:implementation` → `references/phases/implementation.md`

Implementation is terminal in this first protocol version, so it has no next phase
reference. Testing and validation phases are deliberately not modeled yet.

## Find a Journey cheaply

A Journey is identified by one `journey:<codename>` label. For a named Journey:

1. Run `wyrd status --json`.
2. Run `wyrd ticket list --status open --label journey:<codename> --summary --json`.
3. Select the single open, unblocked phase ticket. A blocked open ticket may be the
   prepared next phase and must not be worked yet.
4. Load only that ticket and its open task summaries.
5. Load a complete task only after selecting it.

If zero or multiple open, unblocked phase tickets exist, do not guess. Follow the
resume reference and report the inconsistency or terminal state.

## Context boundary

For ordinary work, retain only:

- the Journey name and destination;
- the current phase objective and conclusion gate;
- accepted predecessor conclusions copied into the current phase input;
- the selected task, its active sibling blockers, and necessary evidence;
- the recommended next action.

Do not load all completed tickets or tasks. Read a predecessor or evidence-bearing task
only when the current phase input is insufficient or needs verification.

## Report compactly

Refer to resources by title first and include the Wyrd ID parenthetically when needed.
Report the Journey, current phase, selected or changed task, durable result, blockers,
and next action. Leave raw exploration outside the report.
