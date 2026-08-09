# Wyrd model for a Journey

Load this reference before creating or editing Journey tickets or tasks.

## Identity and labels

A Journey codename must match `[a-z0-9][a-z0-9_]{0,11}`. Its canonical label is
`journey:<codename>`, which fits Wyrd's 20-character label limit. Do not silently
truncate or rewrite a requested codename; ask for another one if it is invalid.

Every phase ticket has exactly one Journey label and one phase label:

- `phase:definition`
- `phase:planning`
- `phase:implementation`

Additional domain labels are allowed. Use `phase:*`, not `type:*`, because Wyrd already
uses `type` for resource identity.

Every phase task has exactly one primary kind label:

- `kind:research`
- `kind:questioning`
- `kind:decision`
- `kind:prototype`
- `kind:implementation`
- `kind:conclusion`

A phase reference restricts which kinds belong in that phase.

## Ticket titles

Use human-readable titles:

- Definition: `Define <Journey name>`
- Planning: `Plan <Journey name>`
- Implementation: `Implement <Journey name>`

In reports and bodies, write the title before its Wyrd ID. IDs are identities, not
human-readable names.

## Phase ticket body

Use only relevant sections, but preserve this order:

```markdown
## Journey

Name: <human-readable name>
Codename: `<codename>`

## Destination

<current stable statement, provisional during early Definition>

## Phase objective

<what this phase must settle or produce>

## Inputs

<compact accepted predecessor conclusions or initial idea; reference detailed Wyrd
resources by title and ID instead of copying their full bodies>

## Completion gate

<conditions required before the phase may advance>

## Phase conclusion

<!-- Not concluded. -->

## Next phase

<!-- Not prepared. -->
```

Edit `Phase conclusion` and `Next phase` before completing the ticket. Never rely on a
session transcript as the only copy of a conclusion.

## Phase task body

```markdown
## Objective

<one bounded result needed by this phase>

## Expected output

<durable answer, decision, evidence, artifact reference, or implementation result>

## Inputs

<only the context needed for this task>

## Constraints

<scope and decision boundaries>

## Result

<!-- Persist the compact result before completing the task. -->
```

A questioning task may additionally keep an `## Accepted answers` section. Ask one
concise material question at a time and persist accepted answers incrementally when a
session may end before the task does.

## Conclusion task

Each phase has exactly one open `kind:conclusion` task until the phase transition. Its
title describes both actions, for example:

- `Consolidate Definition and prepare Planning`
- `Consolidate Planning and prepare Implementation`
- `Consolidate Implementation and finish the Journey`

The conclusion task must be blocked by every other open sibling task. Whenever a new
non-conclusion task is added, immediately add it as a blocker of the conclusion task.
Task dependencies are valid only between siblings.

## Phase dependencies

The next phase ticket is blocked by the current phase ticket. Create this dependency
while both tickets are open; Wyrd does not allow adding dependencies to terminal
resources.

A blocked phase ticket is prepared state. Do not work any of its tasks even though
Wyrd 0.1 may report child tasks active while their open parent ticket is blocked.

## Efficient reads

Use:

```text
wyrd status --json
wyrd ticket list --status open --label journey:<codename> --summary --json
wyrd task list --ticket <ticket> --status open --summary --json
wyrd ticket view <ticket> --json
wyrd task view <ticket.task> --json
```

Use `--status all` only to diagnose an existing Journey, find a predecessor, or prevent
duplicate phase creation.

## Safe writes

- Use `--body-file` for Markdown bodies.
- Read the resource immediately before editing and pass `--expected-revision`.
- On `revision_conflict`, re-read and reassess; never overwrite blindly.
- Persist a task result before completing it.
- Complete all non-conclusion tasks before the conclusion task.
- Prepare and block the next phase before completing the current ticket.
- Never dismiss work merely to pass a completion gate. Dismiss only when the work is
  intentionally no longer needed and record why in its result.
