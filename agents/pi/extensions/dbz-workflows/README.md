# DBZ Workflows Pi extension

This extension is the Pi-specific command, setup, dashboard, and structured-tool layer for DBZ Workflows. Canonical state remains in the portable core under `skills/dbz-workflows/`.

## Commands

- `/dbz-workflows-setup` configures project-local, managed, or exact external storage. Existing storage can be migrated only after the required disclaimer and explicit confirmation are shown.
- `/dbz-workflows` opens the interactive hub.
- `/dbz-workflows start` plans and confirms workflow ID reservation and workflow-branch creation.
- `/dbz-workflows continue [workflow-id]` validates continuation and shows workflow status.
- `/dbz-workflows status [workflow-id]` shows workflow metadata, tickets, and derived actionable tickets.
- `/dbz-workflows run [ticket-id]` previews a manual execution plan without creating a claim. Dedicated replacement-session creation and bounded context handoff are intentionally left to the session-isolation integration.
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
- manual claims and explicitly confirmed claim recovery;
- executor result submission and coordinator acceptance.

All tool output is bounded to Pi's 50 KB / 2,000-line convention. Mutating tools use both DBZ Workflows core locks/revision guards and Pi's file mutation queue. Managed frontmatter must never be edited directly.

## Safety boundaries

- Project trust is checked before reading project-controlled workflow data.
- Setup and migration plans are read-only until the user confirms the exact reviewed plan.
- External setup displays both the selected path and its effective destination.
- Claims never expire automatically.
- Executors can submit results but cannot complete canonical tickets; completion requires coordinator acceptance.
- This extension does not create replacement Pi sessions or dispatch DBZ Crew workers.
