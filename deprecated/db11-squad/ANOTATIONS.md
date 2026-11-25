# db11-squad architectural annotations (deprecated)

> This proposal is retired. The notes below are preserved for historical reference; there is no runnable extension in this archive.

This document compiles Wyrd task 23.1 and the tasks it directly references: 23.2, 23.4, 23.5, and 23.6. It records the task-level architectural findings and deferred decisions.

## Source tasks

| Task | Title | Status | Role in this compilation |
|---|---|---|---|
| 23.1 | Investigate Pi HERDR capabilities | Open | Selects the initial execution and communication model |
| 23.2 | Evaluate pi-intercom | Completed | Evaluates an alternative communication and result-return mechanism |
| 23.4 | Evaluate subagent process and filesystem isolation | Open | Defers process, filesystem, workspace, and concurrency safety decisions |
| 23.5 | Define subagent runtime configuration | Open | Defers the complete member runtime configuration contract |
| 23.6 | Evaluate autonomous subagent delegation policy | Open | Prohibits autonomous delegation in the PoC and scopes a future policy evaluation |

## Consolidated direction

The selected PoC direction is one independent `pi --mode rpc` child process per Squad Job. The db11-squad extension owns process creation, LF-delimited JSONL communication over stdin and stdout, RPC event handling, cancellation, and cleanup.

A start operation returns a job ID immediately, allowing the squadlead to continue without waiting for the Squad Member. The planned model has a configurable active-process limit, defaulting to four, and queues requests beyond that limit. During the initial PoC, however, a Squad Member may be created only when the requester explicitly asks for delegation.

Herdr, the in-process Pi SDK, and pi-intercom were evaluated but were not selected as initial control or result-delivery dependencies.

## Execution candidates evaluated by task 23.1

### Herdr-managed interactive Pi session

A dedicated Herdr tab and pane would run an interactive Pi process controlled through `herdr agent start`, `prompt`, `get`, `list`, `wait`, and `read`.

Advantages:

- Separate Pi process, session, and conversation context.
- Visible terminal tab with direct human takeover.
- Normalized lifecycle states such as `idle`, `working`, `blocked`, `done`, and `unknown`.
- Strong observability for manually supervised workflows.

Limitations:

- Control remains terminal-oriented.
- Reliable lifecycle reporting depends on the Herdr Pi integration.

### Direct Pi RPC subprocess — selected

The extension starts `pi --mode rpc` as a child and exchanges JSONL commands and events through direct process pipes. It can submit `prompt`, query `get_state`, and consume lifecycle and tool events including `agent_start`, `message_update`, and `agent_settled`.

Advantages:

- Separate process, session, and conversation context.
- Native machine-to-machine protocol with streaming events.
- `get_state.isStreaming` provides an immediate state snapshot.
- `agent_settled` indicates that retries, compaction retries, and queued continuations have settled.
- Stronger isolation than an in-process SDK session.

Responsibilities and limitations:

- No independent interactive TUI or built-in human takeover.
- The extension must manage process lifecycle, JSONL framing, correlation, timeouts, cancellation, and crash recovery.

### In-process Pi SDK `AgentSession`

The extension could create a member session with `createAgentSession()`, submit work with `session.prompt()`, subscribe to lifecycle events, inspect `session.isStreaming`, and await `session.agent.waitForIdle()`.

Advantages:

- Separate conversation history, model state, context, tools, and optional session persistence.
- Typed, low-overhead API.
- Direct state and event access.

Limitations:

- Logical session isolation without operating-system process isolation.
- No independent TUI or native human takeover.
- Process-level failures and resource pressure can affect both squadlead and member sessions.

### Herdr tab running Pi RPC — not preferred

Running RPC inside a Herdr pane would combine a visible process with RPC control, but a PTY can introduce echo, terminal control data, and parsing ambiguity into a protocol that expects clean stdin and stdout JSONL streams. Direct child-process pipes are therefore preferred. A separate bridge could mirror activity into Herdr later if observability requires it.

## Squad Job lifecycle

The task-level model calls for at least these states:

- `queued`
- `starting`
- `running`
- `awaiting_human_input`
- `completed`
- `failed`
- `cancelled`

State should be derived from both process lifecycle and RPC events, including `agent_start`, `agent_settled`, errors, and extension UI requests.

## Observability and retained output

The TUI should display:

- Background jobs and their associated Squad Members or tasks.
- Current state and elapsed time.
- Failures.
- Pending human-input indicators.
- A compact aggregate status.
- A job list and selected-job details.

Observability UI must remain display-only and must not participate in the squadlead model context.

Each Squad Job should retain a complete structured output transcript outside the squadlead context. The default view should show only the latest lines, while an expanded view should allow navigation through the retained transcript. The final authoritative result is stored separately from live output.

Default rendering should include assistant text, summarized tool lifecycle, errors, and state changes. Raw RPC payloads, sensitive values, and `thinking_delta` output should not be exposed by default. Retention must be bounded or moved to file-backed storage as needed to avoid unbounded memory growth.

## Context-isolation policy

Intermediate Squad Member output, human-input requests, and answers sent to a member must never be added automatically to the squadlead context.

Information crosses into that context only through an explicit operation such as `squad_collect(jobId)`, which returns a selected, bounded, or summarized final result. The Squad Job's retained final result is the authoritative source; no second transport should compete with it.

## Human-in-the-loop inbox

The proposed inbox uses Pi's RPC Extension UI Protocol over the existing member process control channel:

1. A Squad Member requests input through a member-side tool or extension.
2. The extension records the request in an inbox and marks the job `awaiting_human_input`.
3. The TUI indicates the pending request without opening an unsolicited modal.
4. The human opens the request and answers through a TUI-only `input`, `select`, `confirm`, or `editor` interaction.
5. The extension sends the answer directly to the member as the correlated `extension_ui_response`.
6. The job returns to `running`.

Questions and answers must not become squadlead conversation messages or tool results.

## Expected control surface

Task 23.1 records the following target operations:

- `squad_start(task)`
- `squad_list()`
- `squad_status(jobId)`
- `squad_select(jobId)`
- `squad_read(jobId)`
- `squad_collect(jobId)`
- `squad_inbox()`
- `squad_answer(requestId, answer)`
- `squad_cancel(jobId)`

This is a target control surface from the architecture task, not a list of currently implemented tools.

## pi-intercom evaluation from task 23.2

Task 23.2 evaluated pi-intercom v0.12.0 at commit `ef95f194de635a01abb6ec8f485c3d4ab6bfc644`.

Pi-intercom connects local Pi sessions through a broker and provides direct messaging, presence, lifecycle status, delivery receipts, request/reply correlation, routing scopes, a consent-aware extension outbox, and non-conversational Extension Channels.

### Why ordinary Intercom messaging was rejected

Ordinary incoming messages are stored in Pi session history, passed through `pi.sendMessage()`, and may trigger a model turn. Using this path for Squad Member results or human-input requests would violate the context-isolation policy. It would also duplicate the direct RPC result path and create competing sources of truth, ordering concerns, duplicate delivery risks, and additional identity and lifecycle complexity.

The `contact_supervisor` tool is also not intended for routine completion handoff. Its decision, interview, timeout, and progress-reporting patterns remain useful prior art, but its ordinary delivery path is not appropriate for the initial inbox.

### Why Extension Channels were deferred

Extension Channels preserve context isolation because they do not call `pi.sendMessage()`, enter the transcript, or start a model turn. They also provide namespaced routing, owner election, presence, bounded publications, and revisioned state.

They were nevertheless rejected for the initial architecture because a broker would be redundant while the squadlead directly owns every member process and its pipes. They should be reconsidered only if members become independently managed, resumable, detached from the squadlead process, or need to coordinate with unrelated live Pi sessions.

### Reusable pi-intercom findings

The following remain useful design references:

- Stable message IDs and `replyTo` correlation.
- Deduplication and explicit terminal delivery receipts.
- Endpoint epochs and rejection of stale destinations.
- Broker-enforced routing scopes.
- Explicit timeout, cancellation, supersession, and non-automatic retry semantics.
- Structured provenance for extension-originated messages.
- Separation among blocking decisions, structured interviews, and meaningful progress updates.

## Deferred decisions

### Task 23.4 — process and filesystem isolation

The initial RPC choice does not settle the security and concurrency implications of running separate processes under the same operating-system user. Follow-up evaluation must cover:

- Shared filesystem access.
- Concurrent writes.
- Workspace separation.
- Git worktrees or equivalent isolation.
- Locking strategies.

### Task 23.5 — Squad Member runtime configuration

A complete configuration contract still needs to define how each member receives:

- Working directory.
- Model and thinking level.
- Allowed tools.
- Session persistence policy.
- System prompt and role identity.
- Timeouts.
- Budget.

### Task 23.6 — autonomous delegation policy

Autonomous delegation is prohibited during the PoC. A Squad Member may be created only after an explicit requester instruction.

A future policy evaluation may consider delegation when work is independent, bounded, parallelizable, or context-heavy enough that intermediate output should remain outside the squadlead context. It should avoid delegation when coordination costs exceed the work, when execution continuously depends on the squadlead conversation, or when concurrency limits make a new member inappropriate. Reusing an existing member should be considered where suitable.

If autonomous delegation is introduced, its normative rules should be exposed to the squadlead through the extension tool's `promptGuidelines`, backed by project documentation and configuration where appropriate.

## Combined conclusion

The compiled tasks establish direct Pi RPC as the initial execution, lifecycle, output-retention, and final-result path. They require explicit context crossing, reject pi-intercom as a duplicate initial transport, and retain Herdr, the Pi SDK, pi-intercom Extension Channels, stronger process/filesystem isolation, complete runtime configuration, and autonomous delegation as alternatives or follow-up work rather than current architectural commitments.
