# DBZ Workflows Pi extension

This extension is the Pi-specific command, setup, dashboard, and structured-tool layer for DBZ Workflows. Canonical state remains in the portable core under `skills/dbz-workflows/`.

## Commands

- `/dbz-workflows-setup` configures project-local, managed, or exact external storage. Existing storage can be migrated only after the required disclaimer and explicit confirmation are shown.
- `/dbz-workflows` opens the interactive hub.
- `/dbz-workflows start` plans and confirms workflow ID reservation and workflow-branch creation.
- `/dbz-workflows continue [workflow-id]` validates continuation and shows workflow status.
- `/dbz-workflows status [workflow-id]` shows workflow metadata, tickets, and derived actionable tickets.
- `/dbz-workflows run [ticket-id]` reviews the manual execution plan, creates or resumes a dedicated claimed Pi session, and injects a bounded context packet assembled only from declared artifact references. Implementation and documentation tickets first display the complete S04 Git plan and require explicit confirmation before creating or adopting their `dbz-tickets/<workflow>/<ticket>-<slug>` branch and sibling ticket worktree.
- `/dbz-workflows verify [workflow-id]` shows verification readiness. Canonical `verification.md` and final-integration gates are separate later operations.
- `/dbz-workflows reconfigure` plans a guarded storage migration.

Commands require a trusted project and Pi TUI or RPC UI. Print and JSON modes fail with an actionable error rather than assuming confirmation. TUI-only custom components are not required; setup and confirmation use Pi dialog APIs that also work over RPC.

## Structured tools

The extension registers focused `dbz_workflows_*` tools for:

- workflow and ticket metadata inspection;
- validated frontmatter and one-section reads;
- selected working-spec section updates;
- ticket creation and non-completion transitions;
- DAG, readiness, and scheduler-wave queries;
- manual claims and explicitly confirmed missing-session claim recovery;
- executor result submission, return to the recorded coordination session, reviewed mutating-result reconciliation/integration/cleanup, and coordinator-only acceptance;
- optional DBZ Crew wave planning, explicit dispatch/resume, result collection, cancellation, and handoff to the same reviewed Git integration flow through `dbz_workflows_crew_executor` when the cohesive DBZ Crew CLI resource is installed.

All tool output is bounded to Pi's 50 KB / 2,000-line convention. Mutating tools use both DBZ Workflows core locks/revision guards and Pi's file mutation queue. Managed frontmatter must never be edited directly.

## Safety boundaries

- Project trust is checked before reading project-controlled workflow data.
- Setup and migration plans are read-only until the user confirms the exact reviewed plan.
- External setup displays both the selected path and its effective destination.
- Claims never expire automatically. A missing executor session or worktree requires confirmation tied to the exact active claim before recovery. A submitted `blocked` or `failed` result reports the core's claim release explicitly.
- Mutating tickets run with Pi runtime `cwd` equal to the applied ticket worktree. In project storage mode, dispatch pauses after the durable claim is created until its canonical artifact change is committed or otherwise leaves the workflow checkout clean; resume revalidates that clean workflow branch. Read-only tickets create no ticket branch or worktree, disable Pi's `bash`, `edit`, and `write` built-ins for that dedicated session, and prohibit project mutation in their execution packet.
- Pi's `newSession()` is not treated as filesystem isolation. The extension creates a fresh persistent session header for the target cwd and switches to it, without `SessionManager.forkFrom()` or copied conversation entries.
- Ticket sessions receive the ticket, declared spec sections, declared decisions, and declared ticket results; repository file bodies and earlier transcripts are not copied.
- Only Pi session locators and durable claim identities needed for recovery are recorded; DBZ Workflows never copies session transcripts into canonical artifacts.
- Executors can submit results but cannot run coordinator-only canonical mutations, accept results, or complete their own tickets. Completion requires a separate coordination session.
- Optional DBZ Crew workers receive only the bounded ticket packet, run with DBZ Workflows skills disabled and canonical mutation tools inactive, and return a bounded `done`, `blocked`, or `failed` protocol. The coordinator adapter normalizes the result and applies canonical state under the core lock and Pi file-mutation queue. Question sessions are never delegated.
- Explicit DBZ Crew waves use the scheduler's confirmed concurrency limit (four by default). Mutating workers reuse the reviewed `dbz-tickets/<workflow>/<ticket>-<slug>` worktree rather than creating a competing Crew branch. In project storage mode, dispatch pauses after claims until canonical claim changes are committed or otherwise leave the workflow checkout clean; claims are retained for explicit resume.
- Crew cancellation closes the worker but preserves its ticket branch/worktree and records a failed attempt so the ticket returns to a safe state. Worker failure or malformed/oversized output retains actionable diagnostics and never completes a ticket.
- Mutating done results require separately reviewed reconciliation and workflow-integration plans. The completed Crew tab is released first without touching the DBZ Workflows-owned worktree. Reconciliation handles commit rebases, and integrated worktree/branch cleanup has its own complete reviewed plan and confirmation; declined or unsafe cleanup preserves the worktree.
- Replacement-session callbacks use only Pi's fresh replacement context.
- When DBZ Crew resources are absent, the optional adapter and its tool are not registered; manual execution behavior is unchanged.
