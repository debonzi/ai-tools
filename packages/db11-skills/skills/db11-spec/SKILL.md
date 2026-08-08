---
name: db11-spec
description: Turn an idea, requirement, or feature request into an implementation-ready specification through guided discovery. Use when the requester wants to define, plan, or specify work before implementation.
---

# DB11 Spec

Understand the requested work before writing the specification.

Read the request and inspect any referenced repositories, files, documentation,
and other relevant context. Do not ask the requester for information that can be
reliably discovered from those sources.

Do not make significant product or technical decisions on your own. Ask every
question needed to determine the scope, behavior, constraints, interfaces,
migration, risks, and acceptance criteria. Ask exactly one concise question per
turn. Prefix each discovery question with its sequence number and current
estimated total, zero-padded to three digits, in the format `(003/087)`. Update
the estimated total between turns whenever new information changes the remaining
discovery scope. When helpful, present options, trade-offs, and a recommendation,
but let
the requester make material decisions.

Continue until no important uncertainty remains. Then write a concise,
implementation-ready specification in the conversation. Include only relevant
sections and clearly distinguish known context, agreed decisions, requirements,
non-goals, implementation guidance, and acceptance criteria.

Ask the requester to review the specification and revise it from their feedback.
Do not implement the work or create persistent files unless separately asked.
