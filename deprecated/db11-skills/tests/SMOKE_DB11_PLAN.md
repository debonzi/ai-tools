# DB11 Plan Smoke Test

Use a disposable local repository with an initialized Wyrd project. This procedure
does not authorize remote access, package publication, implementation of the planned
outcome, delegation to other agents, or changes to unrelated Wyrd tickets.

## 1. Skill discovery

Load the local `packages/db11-skills` workspace in an isolated Pi profile or pass the
`skills/db11-plan` directory through Pi's explicit `--skill` option. Confirm Pi reports
exactly one `skill:db11-plan` command for this resource and no extension is loaded by
the skill.

## 2. Start and materialize

In the disposable project, invoke:

```text
/skill:db11-plan start Define a local-only notification preference model
```

Provide two or three initial constraints and at least one local reference file.
Confirm the agent:

- inspects the reference and project instructions before asking discoverable questions;
- runs `wyrd status --json` but does not run `wyrd init`;
- creates one standalone Plan Ticket with `Protocol: DB11 Plan` and
  `protocol:db11_plan`;
- creates one ordered Plan Topic task per material decision, each with
  `protocol:db11_plan`;
- adds no ticket or task dependencies;
- updates the Plan Ticket topic map with task titles and IDs;
- marks only the first Plan Topic as in discussion;
- presents findings, the complete topic list, a recommendation, alternatives, and
  concrete acceptance points;
- does not implement the notification model.

Create an unrelated Wyrd ticket before this test and confirm DB11 Plan neither reads
its body nor adds any relationship to it.

## 3. Clarify without accepting

Ask for clarification about one acceptance point. Confirm the agent:

- answers only that uncertainty with a bounded example;
- records the clarification and refined wording in the current Plan Topic;
- leaves the task open and its Accepted decisions unchanged;
- does not begin the next Plan Topic.

## 4. Accept and advance

Explicitly accept all current acceptance points. Confirm the agent:

- writes the normative accepted definition into the Plan Topic;
- appends a compact entry to the Plan Ticket decision log;
- completes the task only after both edits succeed;
- activates and presents the next lowest-numbered open Plan Topic in the same response.

Repeat with one partial acceptance and confirm the task stays open until every material
point is accepted. Reject one proposal and confirm the agent revises it rather than
dismissing the topic.

## 5. Resume without conversation history

Exit Pi while a Plan Topic remains in discussion. Start a fresh Pi session and invoke:

```text
/skill:db11-plan resume <ticket-id>
```

Confirm the agent loads only the named Plan Ticket, open task summaries, the current
Plan Topic, and evidence required by that topic. It must recover accepted decisions,
the latest clarification, pending topic titles, and the next acceptance question
without the old conversation.

## 6. Read-only status and inventory

Create two more test tickets directly through Wyrd: one with `protocol:db11_plan` but
without the Tracking marker, and one marker-only legacy Plan Ticket with an unlabeled
Plan Topic. Record the revisions of all test resources, then invoke:

```text
/skill:db11-plan status
```

Confirm the inventory:

- finds the active labeled Plan Ticket and reports its topic counts and current topic;
- finds the marker-only ticket through legacy discovery and reports its missing labels;
- reports the labeled ticket without the marker as an identity inconsistency rather
  than a DB11 Plan;
- excludes the unrelated unlabeled ticket;
- does not select or resume any plan automatically.

Then invoke:

```text
/skill:db11-plan status <ticket-id>
```

Confirm the detailed response reports counts, current and pending Plan Topics, label or
other consistency warnings, and the recommended next operation. Re-read every test
resource and confirm no revision changed during either status operation.

## 7. Conclude with a review gate

After every Plan Topic is completed or explicitly dismissed, invoke:

```text
/skill:db11-plan conclude <ticket-id>
```

Confirm the agent presents a Plan Conclusion synthesized from accepted decisions,
constraints, retained trade-offs, deferred decisions, and boundaries. Before explicit
acceptance, the Plan Ticket must remain open.

Request one revision and confirm the ticket remains open. Then accept the complete Plan
Conclusion and verify the agent persists it, appends the conclusion decision-log entry,
completes the Plan Ticket, and does not start implementation, a Journey, or delegation
to another agent.

## 8. Guardrail checks

In separate disposable attempts, confirm:

- `start` outside a Wyrd project reports the missing project and never initializes one;
- `resume` rejects a labeled ticket without the protocol marker;
- explicit-ID status and resume accept a marker-only legacy Plan Ticket while warning
  about missing labels and making no automatic migration;
- praise and clarification are not treated as acceptance;
- an ambiguous “accept all topics” is clarified when undisclosed topics remain;
- a terminal Plan Topic is not reopened; a later correction becomes a new Plan Topic;
- unexpected dependencies or revision conflicts stop the workflow instead of being
  silently overwritten.
