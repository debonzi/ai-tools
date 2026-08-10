# Start a DB11 Plan

Use this operation only after an explicit `/skill:db11-plan start <problem>` invocation.
That invocation authorizes the standalone ticket and topic-task creation described
below; it does not authorize implementation or unrelated Wyrd changes.

## Establish scope

Extract the problem, desired outcome, requester-given constraints, referenced sources,
and material unknowns. Inspect repository instructions, glossary terms, local files,
documentation, existing behavior, and authorized public sources before asking the
requester.

Ask one concise blocking question only when the objective is too ambiguous to research
or materialize safely. Do not require every future decision before starting; the topic
map exists to settle them.

## Check Wyrd

Run:

```text
wyrd status --json
```

If the project is missing, stop and ask for explicit initialization. Do not inspect
other tickets and do not try to find a related plan: every `start` creates a new
standalone ticket by design.

## Perform the initial analysis

Separate the durable input into:

- requester-given constraints;
- verifiable findings and relevant evidence;
- uncertainties and risks;
- candidate directions that are not yet accepted;
- material topics requiring requester decisions.

A topic should represent one coherent material decision. Order topics so foundational
semantics precede architecture, lifecycle, operational details, and final scope. Do not
encode implementation sequencing as task dependencies.

## Create the ticket

Create one open ticket with the body template from `../../assets/ticket-body.md`.
Include the protocol marker, objective, constraints, sources, initial findings,
candidate direction, and the topic titles. State explicitly that candidate content is
unaccepted.

Use no labels and create no dependencies or relationships to existing tickets.

## Create the topic tasks

Create one task per topic in discussion order using
`../../assets/topic-task-body.md`.

- Give every task a bounded decision-oriented title and Scope.
- Keep later tasks `Not discussed` and do not invent detailed proposals prematurely.
- Fill the first task's evidence, proposal, alternatives, and acceptance points, and
  mark it `In discussion`.
- Create no task dependencies.

After every task exists, re-read the ticket and optimistically update its topic map
with each task title and ID. If any create or edit fails, stop and report the exact
partial state; do not roll forward speculatively or delete successful resources.

## Verify and report

Re-read the ticket and all open task summaries. Verify that task order matches the
topic map and that only the first task is in discussion.

Then report:

- ticket title and ID;
- compact initial findings and unaccepted candidate direction;
- ordered topic titles and IDs;
- the first topic in the standard conversation format.

Do not wait for a separate prompt to present the first topic, and do not accept it on
the requester's behalf.
