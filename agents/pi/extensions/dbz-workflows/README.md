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
- executor result submission, return to the recorded coordination session, reviewed mutating-result reconciliation/integration/cleanup, and coordinator-only acceptance.

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
- Mutating done results require separately reviewed reconciliation and workflow-integration plans. Integrated worktree/branch cleanup has its own complete reviewed plan and confirmation; declined or unsafe cleanup preserves the worktree.
- Replacement-session callbacks use only Pi's fresh replacement context.
- This extension does not dispatch DBZ Crew workers.
