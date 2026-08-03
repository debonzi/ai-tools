# DBZ Workflows V1 Specification

## Document purpose

This document is the canonical implementation specification for DBZ Workflows V1. It is intentionally self-contained so that implementation can be performed by clean agent sessions without access to the design conversation that produced it.

Every implementation session MUST:

1. Read the repository `AGENTS.md` files that apply to the files it will change.
2. Read this document completely, including the General Implementation Rules and Non-Goals.
3. Inspect the current repository state and the Pi documentation relevant to its assigned item.
4. Implement only its assigned implementation-index item and explicitly required scaffolding.
5. Add or update focused tests in the same session.
6. Run the focused tests and all repository checks required by the changed area.
7. Leave later implementation-index items for later sessions.

This specification uses **MUST**, **MUST NOT**, **SHOULD**, and **MAY** normatively.

## Approved decision summary

- DBZ Workflows is a hybrid portable skill, Pi extension, and shared Node.js ESM core/CLI distributed in the existing npm package.
- Project setup is mandatory once per project and validated on every later operation.
- The project itself must be a non-shallow Git worktree with a commit and exactly one root reachable from `HEAD`; artifact storage does not require Git.
- The project key is the full root commit object ID prefixed by its Git object format. Clones, worktrees, and forks intentionally share identity.
- Storage has exactly three V1 modes: fixed project-local, fixed managed external, and exact user-selected external.
- Canonical artifacts are Markdown with YAML frontmatter; JSON is limited to local locators and operational state.
- Specs use an editable working copy plus immutable approved baseline snapshots.
- Baseline-blocking research prevents canonical implementation-ticket creation and feeds synthesis; delivery research may coexist with baseline-bound implementation work.
- Question sessions are interactive, ask one question at a time, and feed synthesis rather than directly editing the spec.
- Tickets are sized for one fresh session and receive a bounded initial context packet.
- Persisted ticket state is simple; readiness and staleness are derived.
- One coordinator owns canonical writes. Executors return results and cannot mark tickets completed themselves.
- Manual execution is mandatory; DBZ Crew is an optional adapter. Explicit waves default to at most four concurrent tickets.
- Every mutating ticket uses an isolated Git branch/worktree and traceable commit trailers.
- Workflow completion requires verification and final integration, not merely readiness to merge.
- DBZ Issues remains an optional intake adapter, and issue closure always requires explicit confirmation.
- V1 does not provide distributed locking, partial baselines, automatic claim expiry, remote issue tracking, or a server/database.

## 1. Purpose and goals

DBZ Workflows is a component for managing durable software-design and delivery workflows for new projects and features in existing projects. A component consists of a skill, a Pi extension, and supporting core/CLI code for one domain.

DBZ Workflows V1 MUST support:

- exploration of an initially vague idea through guided discovery;
- creation and approval of a closed specification baseline;
- research, human question, design, and synthesis cycles before baselining;
- decomposition of the baseline into session-sized tickets;
- dependency-aware ticket scheduling and bounded parallel execution;
- isolated Pi sessions for ticket execution;
- optional delegated execution through DBZ Crew;
- deterministic state transitions and human-readable artifacts;
- Git branch, worktree, commit, verification, and final-integration policies;
- optional linkage to the local DBZ Issues registry;
- project-local, managed external, and user-selected external artifact storage;
- clean distribution through the existing `@debonzi/dbz-ai-tools` npm Pi package.

The canonical workflow state MUST be reconstructable from files. Pi sessions are execution contexts, not the source of truth.

## 2. Terminology

- **Project**: the Git repository in which DBZ Workflows is invoked.
- **Storage root**: the directory containing canonical DBZ Workflows artifacts for one project lineage.
- **Project key**: the deterministic identifier derived from the project's root Git commit.
- **Workflow**: one scoped initiative that progresses from discovery through integration.
- **Spec draft**: the editable working specification.
- **Baseline**: an explicitly approved, immutable snapshot of the spec.
- **Ticket**: one session-sized unit of work in the workflow DAG.
- **Discovery ticket**: a `research`, `question-session`, `design`, or `synthesis` ticket used to close specification uncertainty.
- **Delivery ticket**: a ticket that executes or assures an approved baseline.
- **Actionable ticket**: an `open` ticket whose derived readiness conditions are all satisfied.
- **Coordinator**: the only actor allowed to mutate canonical workflow state during coordinated execution.
- **Executor**: a manual Pi session or delegated worker that performs one ticket and returns a result.
- **Claim**: the durable record assigning one ticket to one executor.

## 3. Component architecture

DBZ Workflows MUST be implemented as three cohesive layers.

### 3.1 Portable skill

Location:

```text
skills/dbz-workflows/
```

Responsibilities:

- guide discovery, specification, synthesis, decomposition, and continuation;
- enforce one-question-at-a-time guided discovery;
- define ticket-quality and result-quality rules;
- instruct the model to use deterministic component tools instead of directly editing metadata;
- provide references and templates loaded through progressive disclosure.

The skill MUST NOT implement canonical state transitions itself.

### 3.2 Pi extension

Location:

```text
agents/pi/extensions/dbz-workflows/
```

Responsibilities:

- register `/dbz-workflows-setup` and `/dbz-workflows`;
- provide interactive setup, dashboards, selections, confirmations, and status;
- register structured tools for model-driven operations;
- integrate with Pi session creation, switching, naming, and context injection;
- expose executor and adapter integrations;
- render concise progress and errors without making TUI behavior mandatory in non-TUI modes.

### 3.3 Shared core and CLI

Locations:

```text
skills/dbz-workflows/scripts/dbz-workflows.mjs
skills/dbz-workflows/lib/
```

Responsibilities:

- parse and safely update Markdown with YAML frontmatter;
- validate schemas, paths, identities, lifecycle transitions, and DAGs;
- resolve storage;
- perform setup, migration, locking, and atomic writes;
- manage workflow and ticket artifacts;
- provide Git primitives;
- calculate readiness and scheduling waves;
- expose deterministic commands used by both the skill and extension.

The core MUST NOT make open-ended product or design decisions that require an LLM or human.

## 4. Package and runtime architecture

DBZ Workflows MUST be added to the existing npm package rather than distributed as a separate package.

The package manifest MUST continue to expose all skills through `./skills` and MUST add:

```json
"./agents/pi/extensions/dbz-workflows/index.ts"
```

to `pi.extensions`.

The npm `files` allowlist MUST include all runtime files under the new skill and extension. Package-content tests MUST be updated accordingly.

The core MUST use JavaScript ESM (`.mjs`) and the extension MAY use TypeScript loaded by Pi through jiti. Add the `yaml` npm package as a production `dependencies` entry. Do not add a compilation step for core modules.

The YAML parser configuration MUST:

- reject duplicate mapping keys;
- reject unsupported custom tags;
- apply a conservative alias limit;
- avoid executable or unsafe schemas;
- produce line/column diagnostics;
- preserve comments and key ordering where practical during metadata-only changes.

No `install` or `postinstall` lifecycle script may be introduced. Runtime state and workflow artifacts MUST remain outside the npm-managed package checkout so that `pi install` and `pi update --extensions` can replace package code safely.

The existing package setup flow and project workflow setup are separate:

- `/skill:dbz-ai-tools-setup` enables the DBZ Workflows skill and extension as a cohesive package feature.
- `/dbz-workflows-setup` configures DBZ Workflows for the current project.

## 5. Project prerequisite and identity

### 5.1 Required Git state

Every configured project MUST:

- be inside a Git worktree;
- have `HEAD` resolving to a commit;
- not be a shallow repository;
- have exactly one root commit reachable from `HEAD`.

Any branch name is valid. Detached `HEAD` is valid. A local `main` or `master` branch is not required.

The setup command MUST refuse unsupported repositories with an actionable diagnostic. It MUST NOT create an initial commit silently. For a new repository, the user may create an empty initial commit before setup.

### 5.2 Project key

The project key is:

```text
git-<object-format>-<full-root-commit-oid>
```

Examples:

```text
git-sha1-0123456789abcdef0123456789abcdef01234567
git-sha256-<full-sha256-object-id>
```

The implementation MUST obtain the object format from Git and MUST retain the complete root object ID. Repository names, filesystem paths, remotes, and shortened hashes MUST NOT be part of the key.

The root commit identifies a Git lineage. Clones, worktrees, and forks that retain that root intentionally share the same project key. When the user chooses external managed or external custom storage, setup MUST briefly display this fact:

> This project is identified by its root Git commit. Clones, worktrees, and forks that share this history will use the same workflow storage.

The notice is informational and does not require a second confirmation.

A root-history rewrite creates a new project key. Existing artifacts are not deleted, but automatic lookup may no longer find them. Recovery or rebinding MUST be explicit.

## 6. Storage and mandatory setup

Setup is mandatory before first use in each project. It persists the selected storage arrangement. Every later operation validates setup and refuses to proceed when configuration is absent, ambiguous, broken, or invalid.

Running setup again MUST be idempotent for an unchanged configuration and MUST support explicit reconfiguration.

### 6.1 Storage mode: project

Fixed storage root:

```text
<project-root>/dbz-workflows/
```

The path is visible and not configurable in V1. Setup MUST NOT use a hidden directory.

Because setup creates tracked project content, it MUST report the resulting Git changes. It MUST NOT silently commit them. Workflow creation requires a clean worktree, so the user must commit or otherwise resolve the setup change before starting a workflow.

Sequential workflow IDs require a reservation visible to later branches. In project storage mode, workflow start MUST reserve the next ID by updating `dbz-workflows.md` on a selected named base branch and creating a dedicated, explicitly confirmed metadata commit before creating the workflow branch. The workflow branch starts from that reservation commit. If the current checkout is detached, protected from local commits, or cannot accept the reservation, the user must select a writable named base branch or use external storage. Concurrent project-mode workflow starts from independent machines are outside V1's locking guarantee and MUST be documented as unsupported.

### 6.2 Storage mode: managed

Fixed storage root:

```text
~/.local/share/dbz-workflows/projects/<project-key>/
```

The implementation MUST use this literal home-relative base path and MUST NOT consult `XDG_DATA_HOME` in V1.

The component creates and manages the directory. It MUST NOT initialize Git there automatically.

### 6.3 Storage mode: external

The user supplies an exact storage root. The component MUST NOT append a project key or other subdirectory to the selected path.

Locator path:

```text
~/.config/dbz-workflows/projects/<project-key>.json
```

The implementation MUST use this literal home-relative config path and MUST NOT consult `XDG_CONFIG_HOME` in V1.

Locator schema:

```json
{
  "schema_version": 1,
  "project_key": "git-sha1-...",
  "storage_path": "/absolute/path/chosen/by/the/user",
  "updated_at": "2026-08-03T15:30:00Z"
}
```

The locator contains only machine-local location metadata. It MUST NOT contain canonical workflow state. Locator files SHOULD use mode `0600`, and their parent directories SHOULD be private to the user.

### 6.4 Root recognition

Every valid storage root MUST contain:

```text
dbz-workflows.md
```

Setup rules:

- Create a missing destination only after validating all prerequisites and parent paths.
- Initialize an empty destination.
- Adopt a destination only when it contains a valid root manifest for the same project key.
- Refuse a manifest belonging to another project lineage.
- Refuse a non-empty destination without a valid root manifest.
- Never overwrite unexpected files or symlinks.
- Never silently repair an invalid manifest.

For an explicitly selected external path that traverses a symlink, setup MUST resolve and display the effective destination before confirmation. It MUST never replace the symlink itself. Project and managed roots MUST reject an unexpected symlink at the target path.

### 6.5 Active-storage resolution

Each operation MUST inspect these candidates:

1. `<project-root>/dbz-workflows/`;
2. `~/.local/share/dbz-workflows/projects/<project-key>/`;
3. the external locator for `<project-key>`.

Resolution rules:

- No valid candidate: require setup.
- Exactly one valid candidate: use it.
- More than one valid candidate: refuse due to ambiguity and require reconfiguration.
- Broken external locator: refuse; do not silently fall back.
- Invalid manifest: refuse; do not repair automatically.

There is no silent precedence among modes.

### 6.6 Reconfiguration and migration

Storage changes use managed migration rather than pointer-only rebinding.

Migration MUST:

1. validate and lock the source;
2. validate the proposed destination and all parent paths;
3. display the complete plan and disclaimer;
4. require confirmation;
5. copy to a temporary destination;
6. validate the copied manifests and compare copied bytes;
7. activate the destination only after successful verification;
8. update or remove the external locator atomically as appropriate;
9. rename the old source as a timestamped backup;
10. never delete that backup automatically.

Required disclaimer:

> Migration may cross filesystem boundaries and cannot be fully atomic. DBZ Workflows will lock its own operations, verify the copied files, and preserve the original directory as a timestamped backup. It cannot prevent external processes from modifying these files during migration.

Backup naming example:

```text
dbz-workflows.migrated-20260803T153000Z/
```

A failed migration MUST leave the old source active. Cleanup may remove only temporary files proven to have been created by the failed operation.

## 7. Canonical artifact format

### 7.1 Human-first Markdown

All canonical DBZ Workflows artifacts MUST be Markdown files with YAML frontmatter. JSON is permitted only for machine-local locators and operational state such as locks, temporary journals, and recreatable caches.

Metadata and narrative MUST remain in one human-readable file. A ticket result belongs in the ticket file rather than a separate result file.

### 7.2 Layout

```text
<storage-root>/
├── dbz-workflows.md
└── <workflow-id>-<immutable-slug>/
    ├── workflow.md
    ├── spec.md
    ├── baselines/
    │   ├── B-0001.md
    │   └── B-0002.md
    ├── decisions/
    │   └── D-0001-<immutable-slug>.md
    ├── tickets/
    │   └── T-0001-<immutable-slug>.md
    └── verification.md
```

There is no additional `workflows/` directory under the storage root.

### 7.3 Frontmatter rules

- Frontmatter MUST start on the first line with `---` and end with a standalone `---`.
- Schema keys and enum values MUST be English and use `snake_case` unless this specification shows otherwise.
- Timestamps MUST be RFC 3339 UTC values.
- Metadata-only operations MUST preserve the Markdown body exactly whenever possible.
- Section operations MUST return or update only the requested section and MUST NOT send unrelated file contents to the LLM.
- Duplicate required headings or malformed heading structure MUST cause a validation error.
- Unknown schema fields MUST be preserved. Validation may warn about unknown fields but MUST NOT silently delete them.
- The core, not the LLM, owns identifiers, counters, lifecycle fields, claims, digests, and dependency metadata.

The core MUST expose operations to:

- parse only frontmatter;
- list artifacts without returning bodies;
- patch selected metadata paths;
- read one named Markdown section;
- replace or append one named Markdown section;
- create an artifact from a validated template;
- validate one artifact or a complete storage root.

File mutations MUST use DBZ Workflows locks, atomic replace semantics, optimistic digest/revision checks, and Pi's file-mutation queue when called through a mutating custom tool.

### 7.4 Root manifest

`dbz-workflows.md` frontmatter MUST include at least:

```yaml
---
artifact: project
schema_version: 1
project_key: git-sha1-0123456789abcdef0123456789abcdef01234567
project_name: example-project
object_format: sha1
root_commit: 0123456789abcdef0123456789abcdef01234567
next_workflow_number: 2
created_at: 2026-08-03T15:30:00Z
updated_at: 2026-08-03T15:30:00Z
---
```

The body SHOULD explain that the directory is managed by DBZ Workflows and direct metadata edits may fail validation.

### 7.5 Workflow manifest

`workflow.md` frontmatter MUST include at least:

```yaml
---
artifact: workflow
schema_version: 1
id: WF-0001
title: Add OAuth authentication
slug: add-oauth-authentication
phase: discovery
conditions: []
current_baseline: null
next_baseline_number: 1
next_ticket_number: 1
next_decision_number: 1
issues: []
git:
  base_branch: main
  base_commit: 0123456789abcdef0123456789abcdef01234567
  workflow_branch: dbz-workflows/WF-0001-add-oauth-authentication
  integrated_commit: null
created_at: 2026-08-03T15:30:00Z
updated_at: 2026-08-03T15:30:00Z
---
```

`base_branch` may be null when the workflow starts from detached `HEAD`; `base_commit` is always required. A target branch must be selected before final integration.

Allowed phases:

```text
discovery → planning → ready → execution → verification → completed
```

`cancelled` is a terminal phase. `blocked` and `awaiting-integration` are conditions, not phases.

### 7.6 Identifier allocation

Identifiers are sequential and human-readable:

- workflows: `WF-0001` and upward, unique within the project;
- tickets: `T-0001` and upward, unique within a workflow;
- decisions: `D-0001` and upward, unique within a workflow;
- baselines: `B-0001` and upward, unique within a workflow.

Allocation MUST occur under lock. Deleted or abandoned numbers MUST NOT be reused. All ticket types use `T-`; the type is stored in frontmatter.

For managed and external storage, the root counter is reserved directly under the canonical storage lock. For project storage, a workflow number is reserved on the selected named base branch in a dedicated confirmed commit before the workflow branch is created. This prevents later local workflow branches from reading the same counter. V1 does not prevent two independent machines from reserving the same project-mode number concurrently without first synchronizing their base branches.

Slugs are generated when the artifact is created, normalized to a safe lowercase kebab form, and then remain immutable. Titles may change. References MUST use IDs, never slugs or paths.

## 8. Workflow lifecycle and gates

### 8.1 Discovery to planning

The gate requires:

- a complete spec draft;
- no unresolved baseline-blocking ticket;
- required question sessions and decisions completed;
- synthesis completed when discovery tickets existed;
- explicit user approval of a baseline snapshot.

### 8.2 Planning to ready

The gate requires:

- implementation and assurance tickets covering the entire baseline;
- valid contracts and acceptance criteria;
- an acyclic dependency graph;
- session-sized tickets within context policy or approved exceptions;
- every delivery ticket referencing the current baseline;
- execution and Git policies resolved.

### 8.3 Ready to execution

The gate requires an explicit execution action. Merely opening status MUST NOT dispatch work.

### 8.4 Execution to verification

The gate requires all mandatory delivery tickets to be completed and all project mutations integrated into the workflow branch.

### 8.5 Verification to completed

The gate requires:

- verification against the current baseline;
- verification evidence tied to the exact verified commit when project changes exist;
- no unresolved failing acceptance criterion;
- final integration into the selected target branch when project changes exist;
- required post-integration validation;
- confirmation that the target branch contains the delivered changes.

A workflow waiting on merge or pull request remains in `verification` with `awaiting-integration`.

### 8.6 Returning to an earlier phase

Planning may return to discovery when it reveals baseline-changing uncertainty.

Execution may suspend the baseline and return to discovery when new evidence changes scope, architecture, behavior, or acceptance criteria. Affected tickets stop being actionable. Existing tickets are not deleted; they are later retained, revised, cancelled, or superseded explicitly.

Scope changes MUST NOT occur silently.

## 9. Discovery, questions, research, design, and synthesis

### 9.1 Workflow start

`/dbz-workflows start` MUST:

1. validate setup and Git prerequisites;
2. require a clean worktree;
3. select or confirm the named target base branch when project storage needs an ID reservation;
4. allocate and durably reserve the workflow ID, using a confirmed base-branch metadata commit in project storage mode;
5. derive the immutable slug;
6. record the effective base ref and commit after reservation;
7. preview and confirm workflow-branch creation;
8. create and switch to the workflow branch;
9. create `workflow.md` and `spec.md` as draft artifacts;
10. record the initial idea;
11. start or prepare a dedicated coordination session.

### 9.2 Guided discovery behavior

Before asking questions, the agent MUST inspect applicable project instructions, architecture, and conventions. It MUST avoid asking for information available in the repository.

Discovery MUST:

- ask one question at a time;
- provide an approximate, adjustable question index;
- offer concrete proposals and trade-offs before broad questions when possible;
- distinguish user decisions from agent assumptions;
- persist confirmed decisions incrementally;
- update the spec draft throughout the session;
- cover problem, users, use cases, scope, non-scope, functional requirements, non-functional requirements, architecture, integrations, data, security, migration, compatibility, rollout, validation, and risks.

No baseline may be created without explicit user approval.

### 9.3 Small inquiry versus ticket

A question or lookup that can be resolved immediately with bounded context MAY remain in the current discovery session.

Create a separate ticket when the work:

- requires a dedicated or unavailable stakeholder;
- requires substantial context or external sources;
- can execute independently or in parallel;
- must be resumed later;
- informs multiple parts of the spec;
- produces reusable evidence or a durable decision.

### 9.4 Baseline-blocking discovery loop

The canonical flow is:

```text
idea
  → spec draft
  → question-session / research / design
  → synthesis
  → approved baseline
  → implementation tickets
```

Multiple discovery waves are allowed. A synthesis result may identify another blocker and create another discovery wave.

`question-session`, baseline-blocking `research`, and `design` tickets MUST NOT directly edit the spec. They record results in their own files. A `synthesis` ticket depends on them and is the only ticket type that incorporates their findings into the spec draft.

Canonical implementation tickets MUST NOT be created while a baseline-blocking research ticket remains open. Notes about possible implementation may remain in the draft but are not executable tickets.

### 9.5 Research classes

`research` tickets MUST declare:

```yaml
research_class: baseline-blocking
```

or:

```yaml
research_class: delivery
```

`baseline-blocking` research can change scope, feasibility, architecture, acceptance criteria, or ticket boundaries. It prevents baselining and implementation-ticket creation.

`delivery` research answers implementation-detail questions under an already stable baseline. It may coexist with implementation tickets, and dependent tickets list it in `depends_on`. If delivery research reveals baseline impact, the coordinator promotes it to baseline-blocking, suspends the baseline, and re-enters discovery.

Discovery research is baseline-blocking by default. A small implementation lookup may remain inside an implementation ticket; a separate ticket is warranted when it needs its own context window or reusable report.

### 9.6 Question sessions

A `question-session` ticket MUST:

- identify the stakeholder or decision owner when known;
- explain why each question matters;
- provide options and recommendations where possible;
- run interactively, one question at a time;
- record questions, answers, unresolved items, and resulting decisions;
- remain incomplete when required answers are unresolved;
- produce decision artifacts for durable decisions.

It cannot be delegated to a non-interactive worker.

### 9.7 Synthesis

Synthesis is an exclusive writer operation. It MUST:

- depend on all discovery inputs in its wave;
- reconcile contradictions;
- update decisions before dependent spec text;
- update the spec draft;
- document unresolved blockers;
- report the sections changed and why;
- never create a baseline without a separate explicit approval action.

## 10. Spec, decisions, and baselines

### 10.1 Working spec

`spec.md` is the editable working copy. Its frontmatter MUST include at least:

```yaml
---
artifact: spec
schema_version: 1
workflow_id: WF-0001
status: draft
based_on: null
current_baseline: null
open_blockers: []
updated_at: 2026-08-03T15:30:00Z
---
```

Allowed statuses are `draft`, `baselined`, and `suspended`.

### 10.2 Baseline snapshots

Approved snapshots are stored as:

```text
baselines/B-0001.md
```

Baseline frontmatter MUST include:

```yaml
---
artifact: baseline
schema_version: 1
id: B-0001
workflow_id: WF-0001
source_synthesis_ticket: T-0003
body_sha256: <sha256-of-normalized-markdown-body>
approved_at: 2026-08-03T15:30:00Z
approved_by: user
---
```

`source_synthesis_ticket` is nullable when discovery reached approval without a separate synthesis ticket.

The digest covers the normalized UTF-8 Markdown body after the closing frontmatter delimiter, using LF line endings and exactly one final newline. It does not cover frontmatter, avoiding a circular digest.

Core tools MUST treat baseline snapshots as immutable. A manual body edit causes digest validation failure; tools MUST NOT silently recalculate the digest.

### 10.3 Revising a baseline

To revise `B-0001`:

1. preserve `B-0001.md` unchanged;
2. set `spec.md` to draft or suspended, based on `B-0001`;
3. perform discovery and synthesis;
4. explicitly approve `B-0002`;
5. revalidate all affected tickets against `B-0002`.

Completed tickets remain completed historical work but do not count as evidence for the new baseline until revalidated or complemented.

### 10.4 Decisions

Decision files MUST describe context, considered options, decision, rationale, consequences, and supersession. Suggested frontmatter:

```yaml
---
artifact: decision
schema_version: 1
id: D-0001
workflow_id: WF-0001
status: accepted
supersedes: null
superseded_by: null
created_at: 2026-08-03T15:30:00Z
updated_at: 2026-08-03T15:30:00Z
---
```

## 11. Ticket model

### 11.1 V1 ticket types

| Type | Purpose | Required result |
|---|---|---|
| `research` | Investigate a bounded question | Evidence, sources, conclusion, confidence, and impact |
| `question-session` | Obtain human answers or decisions | Questions, answers, unresolved items, and decisions |
| `design` | Define a technical solution | Alternatives, decision, rationale, and consequences |
| `synthesis` | Incorporate discovery into the spec draft | Reconciled changes and remaining blockers |
| `implementation` | Change code, configuration, tests, or infrastructure | Changes, commits, validation, and deviations |
| `documentation` | Produce project or user documentation | Documents changed and validation |
| `review` | Evaluate a specific artifact or change | Classified findings and recommendation |
| `verification` | Verify baseline compliance | Criterion-by-criterion evidence and outcome |

`planning` is a workflow-phase operation, not a ticket type. Git integration is a coordinator operation, not a V1 ticket type. Bugs and features describe workflow origin, not ticket types. Custom ticket types are not supported in V1.

### 11.2 Required ticket frontmatter

```yaml
---
artifact: ticket
schema_version: 1
id: T-0001
workflow_id: WF-0001
title: Evaluate OAuth provider compatibility
slug: evaluate-oauth-provider-compatibility
type: research
status: open
spec_baseline: null
research_class: baseline-blocking
depends_on: []
superseded_by: []
execution:
  mode: delegatable
  parallel_safe: true
  conflicts_with: []
  claim: null
context:
  spec_sections: []
  decisions: []
  tickets: []
  files: []
context_budget_exception: null
created_at: 2026-08-03T15:30:00Z
updated_at: 2026-08-03T15:30:00Z
---
```

Fields not applicable to a ticket type MUST be null or omitted according to the versioned schema. The core MUST expose normalized typed output regardless of omission.

### 11.3 Required Markdown contract

Every ticket MUST contain:

```markdown
# Ticket title

## Objective
## Context
## Scope
## Out of Scope
## Inputs
## Deliverables
## Acceptance Criteria
## Validation
## Result
```

Type templates MAY add required sections such as `Research Question`, `Sources`, `Questions`, `Alternatives`, or `Findings`.

### 11.4 Session-size policy

A ticket may become `open` only after contract validation. It becomes actionable only if it is expected to be completable in one fresh session, ideally without compaction.

Split a ticket when:

- it has more than one independently verifiable outcome;
- it crosses unrelated subsystems without atomic necessity;
- it contains unresolved research or design work;
- one part can create a stable handoff for another;
- execution is likely to require compaction;
- acceptance criteria can be validated independently.

Do not impose fixed hour, line-of-code, or file-count limits. An atomic change may legitimately touch many files.

### 11.5 Initial context budget

The default initial ticket context budget is:

```text
min(25% of the active model context window, 32,000 tokens)
```

The initial bundle includes only:

- the ticket;
- explicitly referenced spec sections;
- referenced decisions;
- referenced ticket results;
- other explicitly declared inputs.

Repository files are explored during execution and are not automatically embedded wholesale.

The extension SHOULD use Pi's model/context information for estimates. The CLI MAY use a documented conservative fallback estimate when no model is active.

A ticket over budget cannot normally pass readiness validation. A user-approved exception MUST record a justification in `context_budget_exception`.

### 11.6 Persisted states

Allowed persisted states:

```text
draft
open
in-progress
blocked
completed
cancelled
superseded
```

Normal flow:

```text
draft → open → in-progress → completed
```

Additional allowed transitions include:

- `open → blocked`;
- `in-progress → blocked`;
- `blocked → open` after its condition is resolved;
- `in-progress → open` after a failed or aborted attempt is safely released;
- any non-terminal state to `cancelled` or `superseded` with rationale.

`completed`, `cancelled`, and `superseded` are terminal for V1. Follow-up work uses new tickets.

A failed executor attempt is not itself a terminal ticket state. The coordinator records the failure and returns the ticket to `open` or `blocked`.

### 11.7 Derived readiness and staleness

`ready` and `stale` MUST NOT be persisted as ticket states.

A ticket is actionable when:

- status is `open`;
- its type is allowed in the current workflow phase;
- all `depends_on` tickets are `completed`;
- its referenced baseline is current when one is required;
- no external block exists;
- its contract, context, and execution metadata validate;
- no conflicting ticket is actively claimed.

A ticket is stale when its baseline reference no longer matches the current baseline or its referenced inputs have been superseded.

### 11.8 DAG rules

- Dependencies use ticket IDs.
- Cycles are invalid.
- Only `completed` satisfies a dependency.
- A cancelled or superseded dependency requires explicit replanning; no automatic rewiring.
- Conditional delivery branches are not supported before synthesis in V1.
- Independent actionable tickets may be included in the same execution wave when execution policy permits.

## 12. Sessions, claims, and result acceptance

### 12.1 Coordination sessions

A coordination session may create, continue, inspect, plan, dispatch, and verify workflows. It is replaceable and MUST NOT contain unique canonical information.

### 12.2 One ticket per execution session

Each ticket runs in a dedicated Pi session or delegated worker context. The extension MUST:

1. claim the ticket atomically;
2. create a bounded context packet;
3. create or select the execution session;
4. set a descriptive session name;
5. inject the ticket packet;
6. retain enough locator data to resume when possible.

If the original Pi session is unavailable, a new session can continue from canonical artifacts. No ticket may require reading the old Pi conversation.

Principle:

> A session executes a ticket, but no ticket depends on the survival of a session.

### 12.3 Claims

A claim is stored in ticket frontmatter:

```yaml
execution:
  mode: manual
  parallel_safe: false
  conflicts_with: []
  claim:
    executor: manual
    session_id: <pi-session-id>
    claimed_at: 2026-08-03T15:30:00Z
```

Claims MUST NOT expire silently. Releasing an abandoned claim requires explicit recovery, records the reason, and invalidates the previous executor token or identity.

### 12.4 Executor result protocol

Executors return one of:

```text
done
blocked
failed
```

An executor cannot mark canonical state completed. The coordinator:

1. receives and validates the result;
2. writes it into the ticket's `## Result` section;
3. validates deliverables and evidence;
4. verifies acceptance criteria;
5. verifies Git integration and tests for mutating tickets;
6. transitions to `completed` only after acceptance.

Required result structure:

```markdown
## Result

### Summary
### Deliverables
### Acceptance Criteria Evidence
### Validation
### Deviations
### Follow-ups
```

Type-specific templates add sections such as sources, answers, or findings.

Human approval is required for:

- question-session answers and decisions;
- decisions marked human-required;
- baseline approval;
- claim recovery;
- storage migration;
- final integration;
- DBZ Issues closure.

Routine technical tickets may be accepted by the coordinator when evidence is deterministic and complete.

## 13. Scheduler and executors

### 13.1 Scheduler responsibilities

The scheduler MUST:

- compute actionable tickets;
- respect phase, dependency, conflict, and executor constraints;
- form execution waves;
- claim tickets before dispatch;
- prevent duplicate execution;
- collect normalized results;
- release dependent tickets only after coordinator acceptance.

Opening a dashboard or status view MUST NOT dispatch work.

### 13.2 Manual executor

The manual executor is mandatory and always available in interactive Pi mode. It creates a dedicated ticket session and follows the same claim/result protocol as delegated execution.

### 13.3 Optional DBZ Crew executor

DBZ Crew integration is optional. DBZ Workflows MUST function when DBZ Crew resources are absent or disabled.

The adapter MUST translate between a ticket/context bundle and a normalized executor result. It MUST not let a worker mutate canonical DBZ Workflows state directly. Existing DBZ Crew interfaces and event behavior MUST be inspected during implementation rather than guessed.

### 13.4 Type execution defaults

- `question-session`: manual and interactive only.
- `research`: delegatable and parallel by default.
- `design`: delegatable for proposals; required decisions may still need human approval.
- `synthesis`: exclusive writer and never parallel with planning writes.
- `implementation` and `documentation`: delegatable only when Git policy can provide isolation.
- `review`: preferably read-only and delegatable.
- final `verification`: exclusive.

### 13.5 Parallel waves

Ticket metadata controls parallelism:

```yaml
execution:
  mode: delegatable
  parallel_safe: true
  conflicts_with: []
```

Rules:

- dispatch must be explicit and its plan displayed first;
- default maximum concurrency is four;
- mutating tickets require `parallel_safe: true` opt-in;
- research is parallel by default when dependencies permit;
- question sessions are never scheduler-parallel;
- synthesis and final verification are exclusive;
- results are integrated individually;
- unexpected conflicts block the affected ticket rather than triggering silent resolution.

## 14. Concurrency, locking, and recovery

V1 uses a single canonical writer. Workers return results; the coordinator applies canonical changes.

Operational state location:

```text
~/.local/state/dbz-workflows/
```

The implementation MUST use this literal path in V1 and index locks by project key and canonical storage path.

Requirements:

- parallel reads are allowed;
- canonical writes are serialized;
- mutations use short-lived process locks and atomic file replacement;
- expected revision/digest checks detect human edits between read and write;
- unexpected differences cause errors, not last-write-wins behavior;
- temporary files are created with unique names in a safe location on the same filesystem when atomic rename is required;
- stale operational locks and durable claims are distinct concepts;
- claim recovery is explicit and auditable.

V1 protects concurrent Pi sessions and component processes on one machine. It does not provide distributed locking across machines or synchronize independent artifact copies.

Custom Pi tools that mutate files MUST also participate in Pi's `withFileMutationQueue()` using the resolved target path so built-in and custom mutations cannot race.

## 15. Git policy

### 15.1 Workflow branch

Create a workflow branch at workflow start:

```text
dbz-workflows/<workflow-id>-<workflow-slug>
```

Creation requires a clean worktree and explicit confirmation. In project storage mode, any required workflow-ID reservation commit occurs first, and the workflow branch starts from that commit. The effective base ref and commit are recorded in `workflow.md`. If the branch already exists, adoption is allowed only when its metadata matches the same workflow.

Discovery, spec, and planning occur on this branch. In project storage mode, canonical artifacts are versioned there. In external storage modes, the branch may initially contain no changes.

### 15.2 Ticket branch and worktree

Every ticket that modifies the project, including `implementation` and project-documentation work, MUST use an isolated branch and worktree:

```text
dbz-tickets/<workflow-id>/<ticket-id>-<ticket-slug>
```

Separate `dbz-workflows` and `dbz-tickets` namespaces avoid Git ref prefix conflicts.

Read-only research, question, design, review, and verification tickets do not require code branches. Synthesis updates canonical artifacts exclusively through the coordinator.

### 15.3 Ticket commits

A mutating ticket may produce one or more coherent commits. Squashing is not required.

Every ticket commit MUST follow the target project's commit rules and include:

```text
DBZ-Workflow: WF-0001
DBZ-Ticket: T-0007
```

The coordinator MUST record final integrated commit IDs in the ticket result. Worker commit IDs that change during rebase are not final evidence.

A mutating ticket is not completed until:

1. its branch is reconciled with the current workflow branch;
2. required validation passes;
3. commits are integrated into the workflow branch;
4. the coordinator accepts the result.

### 15.4 Canonical artifact commits in project mode

Workers do not write the canonical workflow copy. The coordinator writes returned results and planning changes on the workflow branch. Before dispatching code work from project storage mode, canonical artifact changes MUST be committed or otherwise leave the worktree clean.

Git-mutating operations MUST show a plan and require confirmation unless they are part of a previously confirmed execution batch with explicit authorization.

### 15.5 Final integration

DBZ Workflows MUST never silently merge the workflow branch into the target branch.

Final integration requires:

1. successful verification of the workflow branch;
2. explicit confirmation;
3. reconciliation with the target branch;
4. integration or confirmed external PR merge;
5. required post-integration validation;
6. confirmation that the target contains the changes.

A verified commit becomes stale if additional commits enter the workflow branch.

## 16. Verification and completion

`verification.md` MUST provide criterion-by-criterion evidence against the current baseline.

Suggested frontmatter:

```yaml
---
artifact: verification
schema_version: 1
workflow_id: WF-0001
baseline: B-0001
verified_commit: <full-commit-id-or-null>
outcome: passed
verified_at: 2026-08-03T15:30:00Z
---
```

Allowed outcomes are `pending`, `passed`, `failed`, and `blocked`.

Verification MUST:

- inspect every baseline acceptance criterion;
- reference concrete tests, files, commands, artifacts, or ticket results;
- verify all mandatory tickets;
- identify deviations and limitations;
- fail when evidence is missing;
- become stale when the baseline or verified commit changes.

A failed verification creates correction tickets, returns the workflow to execution, and requires a new verification pass. Verification does not directly change implementation code.

`completed` means delivered and integrated, not merely ready to merge. A no-code workflow may complete directly after successful verification.

## 17. DBZ Issues integration

DBZ Issues remains an intake and backlog registry. DBZ Workflows tickets MUST NOT be mirrored as DBZ Issues entries.

`workflow.md` issue links use:

```yaml
issues:
  - id: ISSUE-001
    relation: resolves
  - id: ISSUE-014
    relation: partially-addresses
```

Allowed relations:

- `resolves`: successful workflow completion may resolve the issue;
- `partially-addresses`: the workflow delivers only part and cannot close it;
- `related`: context only.

Starting from an issue MUST:

1. copy or reference its context as an input;
2. record a bidirectional link through the DBZ Issues adapter;
3. leave the issue open;
4. run normal discovery.

An issue linked with `resolves` becomes eligible for closure only after:

- workflow phase is `completed`;
- final integration is confirmed;
- verification passed;
- no deviation invalidates the resolution.

Closure always requires explicit user confirmation and MUST use the DBZ Issues interface rather than directly editing registry files.

A cancelled workflow leaves its issues open by default. The user may explicitly close an issue as rejected, duplicate, obsolete, or not planned, with a reason, when supported by the DBZ Issues contract.

Out-of-scope findings may create new issues after confirmation. In-scope findings create workflow tickets instead.

## 18. Pi command and tool surface

### 18.1 Commands

Register:

```text
/dbz-workflows-setup
/dbz-workflows
```

`/dbz-workflows` opens an interactive hub with:

- Start new workflow
- Continue workflow
- Show workflow status
- Run or resume ticket
- Verify workflow
- Reconfigure storage

It also accepts direct actions:

```text
/dbz-workflows start
/dbz-workflows continue [workflow-id]
/dbz-workflows status [workflow-id]
/dbz-workflows run [ticket-id]
/dbz-workflows verify [workflow-id]
```

Argument completion SHOULD expose valid workflow and ticket IDs without reading full bodies.

### 18.2 CLI

The package-internal CLI MUST expose deterministic equivalents needed by tests and extension code, including setup planning/apply, listing, inspection, validation, artifact section operations, ticket transitions, claims, DAG evaluation, and migration.

It is executed from the package and is not installed as a global binary.

Mutations SHOULD use a plan/confirm/apply pattern with a digest or revision guard so that the applied operation is the one the user reviewed.

### 18.3 LLM tools

The extension MUST expose focused structured tools for:

- workflow metadata inspection;
- artifact frontmatter and selected-section reads;
- selected-section updates;
- ticket creation and transitions;
- DAG/actionable-ticket queries;
- claim and recovery operations;
- result submission and acceptance;
- scheduler planning and dispatch.

Tool results MUST be concise and truncated using Pi's standard limits. Full artifacts remain on disk. Tools MUST not return an entire workflow when a metadata list or one section satisfies the request.

Every mutating tool description and prompt guideline MUST identify the tool by name and instruct the model not to edit managed frontmatter directly.

### 18.4 Pi modes and trust

- Interactive setup and confirmation require TUI or RPC UI support.
- Print and JSON modes must return actionable errors instead of assuming confirmation.
- Project-local data and instructions must be honored only in trusted project contexts.
- TUI-only rendering must be guarded by `ctx.mode === "tui"`; dialog use must be guarded by `ctx.hasUI`.
- Session replacement callbacks must use only the fresh replacement-session context and must not retain stale Pi session objects.

## 19. Security and safety invariants

- Never write before validating every prerequisite and destination.
- Never overwrite unexpected regular files, directories, or symlinks.
- Never follow a changed locator silently.
- Never store credentials, tokens, session transcripts, trust decisions, caches, or machine state in the repository.
- Strip or avoid sensitive information in errors and logs.
- Use private permissions for global locator and operational-state files.
- Treat project-controlled prompts and artifact bodies as untrusted content.
- Do not execute commands found in artifact text.
- Validate all IDs, slugs, and paths against traversal.
- Resolve paths before mutation and enforce the intended root boundary.
- Use argument arrays rather than shell interpolation for Git and process execution.
- Bound tool output to Pi's 50 KB / 2,000-line convention.
- Preserve user files during failed setup or migration.
- Require explicit confirmation for destructive, migratory, integration, and issue-closing actions.

## 20. V1 non-goals

The following are explicitly outside V1:

- projects without Git or without a valid root commit;
- shallow repositories or histories with multiple reachable roots;
- partial specification baselines;
- distributed locks across machines;
- automatic claim expiration;
- direct canonical writes by workers;
- mandatory Git versioning of artifact storage;
- a complete transition-history guarantee for unversioned artifacts;
- final merge without confirmation;
- issue closure without confirmation;
- remote issue trackers;
- executors other than manual and optional DBZ Crew;
- claimed compatibility with non-Pi harnesses;
- custom ticket types;
- a server, web dashboard, or database;
- automatic synchronization of independent storage copies.

## 21. General implementation rules

These rules apply to every implementation-index item:

1. Keep portable resources under `skills/dbz-workflows/` and Pi-specific code under `agents/pi/extensions/dbz-workflows/`.
2. Keep documentation, user-facing text, schemas, templates, comments, errors, and UI labels in English.
3. Treat this specification as normative. Do not silently simplify safety requirements.
4. Inspect and follow the complete relevant Pi documentation and examples before implementing Pi APIs.
5. Keep the core deterministic and testable without starting Pi.
6. Keep model behavior in the skill and deterministic mutation in the core.
7. Do not duplicate lifecycle or schema rules in multiple implementations; centralize them.
8. Add tests with every behavior. Do not defer the test suite to the final session.
9. Use exact, actionable errors and distinguish invalid state from absent state.
10. Make setup and mutating operations idempotent where specified.
11. Preserve forward-compatible unknown fields while rejecting invalid required fields.
12. Do not implement later index items except minimal interfaces or scaffolding required by the current item.
13. Run existing repository tests before declaring an item complete.
14. Use Conventional Commits for commits in this repository.
15. Add a Changeset for user-visible package changes at the appropriate integration stage.

## 22. Implementation index

Implementation should normally proceed in order. A later item may begin only when all listed dependencies are implemented and committed. Each clean implementation session must read this whole document, then focus on its assigned item.

### S01 — Frontmatter and filesystem foundation

**Dependencies:** none.

**Scope:**

- Create the `skills/dbz-workflows/` core directory structure.
- Add the `yaml` runtime dependency.
- Implement safe Markdown/frontmatter parsing and serialization.
- Implement metadata-only patching that preserves bodies.
- Implement bounded level-two section reads and replacements.
- Implement schema/error primitives, path-boundary checks, atomic writes, digests, and local mutation locks.
- Establish test fixtures for valid and malformed artifacts.

**Expected files:**

```text
skills/dbz-workflows/lib/frontmatter.mjs
skills/dbz-workflows/lib/markdown.mjs
skills/dbz-workflows/lib/filesystem.mjs
skills/dbz-workflows/lib/errors.mjs
skills/dbz-workflows/lib/*.test.mjs
```

**Acceptance criteria:**

- Duplicate YAML keys, unsafe tags, excessive aliases, malformed delimiters, duplicate managed sections, and traversal are rejected.
- Metadata patches preserve unrelated frontmatter fields, comments where supported, and body content.
- Section operations do not return unrelated sections.
- Concurrent mutation tests demonstrate serialization and stale-revision rejection.
- Atomic-write failure tests preserve the original file.

**Out of scope:** Git identity, storage modes, workflow schemas, Pi extension.

### S02 — Git project identity and storage resolution

**Dependencies:** S01.

**Scope:**

- Implement Git prerequisite checks and process execution without shell interpolation.
- Detect project root, object format, shallow state, `HEAD`, and root commits.
- Derive the full project key.
- Implement the three candidate paths and external locator schema.
- Implement root-manifest parsing and candidate resolution without silent precedence.
- Add fork/clone lineage notice data for the UI.

**Expected files:**

```text
skills/dbz-workflows/lib/git-identity.mjs
skills/dbz-workflows/lib/storage.mjs
skills/dbz-workflows/lib/locators.mjs
skills/dbz-workflows/lib/*storage*.test.mjs
```

**Acceptance criteria:**

- Normal, detached, shallow, no-commit, multiple-root, and non-Git cases are tested.
- Project keys use full OIDs and distinguish SHA-1/SHA-256.
- Broken locators and multiple candidates fail explicitly.
- No test writes to the real user's home directory.

**Out of scope:** setup mutations and migration.

### S03 — Setup, adoption, reconfiguration, and migration

**Dependencies:** S01, S02.

**Scope:**

- Implement setup plan/apply operations for project, managed, and external modes.
- Create and validate `dbz-workflows.md`.
- Implement safe adoption and idempotent reruns.
- Implement migration planning, disclaimer, confirmation boundary, verified copy, activation, locator updates, and backup rename.
- Add CLI commands for non-interactive planning and explicitly authorized apply operations.

**Expected files:**

```text
skills/dbz-workflows/lib/setup.mjs
skills/dbz-workflows/lib/migration.mjs
skills/dbz-workflows/scripts/dbz-workflows.mjs
skills/dbz-workflows/lib/*setup*.test.mjs
skills/dbz-workflows/lib/*migration*.test.mjs
```

**Acceptance criteria:**

- All destination states and conflict cases are tested.
- Unexpected files and symlinks are never overwritten.
- Failed cross-filesystem-style migration simulations leave the source active.
- Successful migration preserves a timestamped backup.
- External locators use the fixed confirmed path and private permissions.

**Out of scope:** Pi setup UI and workflow creation.

### S04 — Git branch, worktree, and commit operations

**Dependencies:** S01, S02.

**Scope:**

- Implement clean-worktree checks.
- Implement workflow and ticket branch naming and validation.
- Implement confirmed branch creation and safe adoption checks.
- Implement isolated ticket worktree lifecycle primitives.
- Implement commit trailer validation.
- Implement reconciliation, integrated-commit discovery, and final-containment checks.
- Expose plans rather than silently performing final merges.

**Expected files:**

```text
skills/dbz-workflows/lib/git-operations.mjs
skills/dbz-workflows/lib/git-plans.mjs
skills/dbz-workflows/lib/*git*.test.mjs
```

**Acceptance criteria:**

- Tests use disposable real Git repositories.
- Ref namespace conflicts, dirty worktrees, stale bases, rebased OIDs, missing trailers, and branch adoption mismatch are covered.
- No final merge happens without an explicit apply operation tied to a reviewed plan.

**Out of scope:** workflow lifecycle and Pi UI.

### S05 — Workflow lifecycle and canonical artifacts

**Dependencies:** S01–S04.

**Scope:**

- Implement root counters and locked workflow ID allocation.
- Implement immutable slug generation.
- Create the workflow branch and canonical directory/artifacts.
- Implement `workflow.md` schema and phase/condition transitions.
- Implement workflow listing, inspection, cancellation, and continuation validation.
- Implement issue-link storage without the DBZ Issues adapter.

**Expected files:**

```text
skills/dbz-workflows/lib/workflows.mjs
skills/dbz-workflows/lib/schemas/project.mjs
skills/dbz-workflows/lib/schemas/workflow.mjs
skills/dbz-workflows/lib/templates/workflow.mjs
skills/dbz-workflows/lib/*workflow*.test.mjs
```

**Acceptance criteria:**

- IDs are never reused.
- Project-mode ID reservation is committed on the named base before branch creation and is covered by synchronization/conflict tests.
- Slugs and paths remain stable after title changes.
- Invalid phase transitions fail.
- Workflow creation records exact base and branch data.
- Project-mode creation respects clean-worktree requirements and refuses unsupported detached-base reservation.

**Out of scope:** spec baselines, tickets, extension commands.

### S06 — Spec lifecycle, decisions, synthesis, and baselines

**Dependencies:** S05.

**Scope:**

- Implement spec and decision schemas/templates.
- Implement draft, suspended, and baselined states.
- Implement decision allocation and supersession.
- Implement synthesis input validation and exclusive-write guards.
- Implement explicit baseline approval, snapshot creation, body digest, and immutability checks.
- Implement baseline revision and affected-artifact staleness data.

**Expected files:**

```text
skills/dbz-workflows/lib/specs.mjs
skills/dbz-workflows/lib/decisions.mjs
skills/dbz-workflows/lib/baselines.mjs
skills/dbz-workflows/lib/schemas/*.mjs
skills/dbz-workflows/lib/templates/*.mjs
skills/dbz-workflows/lib/*baseline*.test.mjs
```

**Acceptance criteria:**

- Baselines cannot be created with blockers or without an explicit approval apply operation.
- Snapshot body changes are detected.
- Revising a baseline preserves old snapshots.
- Synthesis cannot bypass required dependencies.

**Out of scope:** model-authored discovery instructions and ticket DAGs.

### S07 — Ticket contracts, state machine, DAG, and context budgets

**Dependencies:** S05, S06.

**Scope:**

- Implement all V1 ticket schemas and templates.
- Implement ticket ID allocation and immutable slugs.
- Implement state transitions and terminal behavior.
- Implement dependency validation, cycles, actionable calculation, conflicts, and baseline staleness.
- Implement context-reference extraction and budget estimation/exception validation.
- Implement decomposition coverage hooks that the skill can use.

**Expected files:**

```text
skills/dbz-workflows/lib/tickets.mjs
skills/dbz-workflows/lib/dag.mjs
skills/dbz-workflows/lib/context-budget.mjs
skills/dbz-workflows/lib/schemas/ticket.mjs
skills/dbz-workflows/lib/templates/tickets/*.mjs
skills/dbz-workflows/lib/*ticket*.test.mjs
```

**Acceptance criteria:**

- Every ticket type validates its required metadata and body sections.
- Baseline-blocking research prevents implementation-ticket creation.
- Delivery research can participate in a baseline-bound DAG.
- `ready` and `stale` remain derived.
- Cycle and cancelled/superseded dependency behavior is tested.

**Out of scope:** session creation and delegated execution.

### S08 — Scheduler, claims, executor protocol, and manual execution

**Dependencies:** S07.

**Scope:**

- Implement durable claims and explicit recovery.
- Implement scheduler wave calculation and maximum concurrency.
- Implement executor/result interfaces.
- Implement coordinator result application and acceptance checks.
- Implement the core manual-executor flow independently of Pi UI.
- Enforce exclusive synthesis/verification and mutating-ticket opt-in parallelism.

**Expected files:**

```text
skills/dbz-workflows/lib/claims.mjs
skills/dbz-workflows/lib/scheduler.mjs
skills/dbz-workflows/lib/executors/*.mjs
skills/dbz-workflows/lib/results.mjs
skills/dbz-workflows/lib/*scheduler*.test.mjs
```

**Acceptance criteria:**

- Duplicate claims are impossible under tested concurrency.
- Claims never expire automatically.
- Waves contain no dependency or declared conflict.
- Default concurrency is four.
- Executors cannot mark canonical tickets completed.
- Acceptance requires evidence and integrated commits for mutating tickets.

**Out of scope:** Pi session APIs and DBZ Crew.

### S09 — Pi extension commands, setup UI, and workflow dashboard

**Dependencies:** S03, S05, S07, S08.

**Scope:**

- Create the Pi extension entry point.
- Register `/dbz-workflows-setup` and `/dbz-workflows` with completions.
- Implement setup/reconfiguration dialogs and migration disclaimer/confirmation.
- Implement the interactive hub, workflow list/status, actionable-ticket view, and validation errors.
- Register focused read and mutation tools backed by the core.
- Add compact renderers/status widgets only where they improve usability.
- Handle TUI, RPC, JSON, and print modes correctly.

**Expected files:**

```text
agents/pi/extensions/dbz-workflows/index.ts
agents/pi/extensions/dbz-workflows/commands.ts
agents/pi/extensions/dbz-workflows/tools.ts
agents/pi/extensions/dbz-workflows/ui.ts
agents/pi/extensions/dbz-workflows/*.test.ts
agents/pi/extensions/dbz-workflows/README.md
```

**Acceptance criteria:**

- Project trust and UI capabilities are checked.
- Noninteractive modes never assume confirmation.
- Tool output is bounded.
- Mutating tools use both core locks and Pi's file mutation queue.
- Commands expose start, continue, status, run, verify, and reconfigure behavior.

**Out of scope:** creating replacement Pi sessions and DBZ Crew dispatch.

### S10 — Session isolation, context handoff, and result acceptance

**Dependencies:** S08, S09.

**Scope:**

- Implement dedicated ticket-session creation and naming.
- Build bounded context packets from explicit artifact references.
- Implement ticket resume and recovery when a previous session is missing.
- Implement result submission, coordinator acceptance, and return-to-coordination flows.
- Persist only session locators/claims needed for recovery, never session transcripts.

**Expected files:**

```text
agents/pi/extensions/dbz-workflows/sessions.ts
agents/pi/extensions/dbz-workflows/context.ts
agents/pi/extensions/dbz-workflows/results.ts
agents/pi/extensions/dbz-workflows/*session*.test.ts
```

**Acceptance criteria:**

- A fresh session can execute a ticket without reading an earlier transcript.
- Context bundles include only declared sections and remain under budget unless explicitly excepted.
- Session replacement uses only fresh contexts and no stale Pi objects.
- Missing sessions recover explicitly without silently releasing claims.

**Out of scope:** DBZ Crew workers.

### S11 — Discovery and planning skill

**Dependencies:** S06, S07, S09, S10.

**Scope:**

- Add `SKILL.md` with a precise trigger description.
- Add discovery, research, question-session, design, synthesis, decomposition, and continuation references.
- Encode one-question-at-a-time behavior, indexed discovery, proposal-first questioning, and incremental persistence.
- Instruct the model to use extension/core tools and never directly modify managed metadata.
- Add templates/examples without duplicating machine schemas.
- Define non-trigger cases so ordinary planning or coding does not automatically start a durable workflow.

**Expected files:**

```text
skills/dbz-workflows/SKILL.md
skills/dbz-workflows/references/*.md
```

**Acceptance criteria:**

- The skill is valid under the Agent Skills standard.
- Instructions cover the complete discovery loop and research policy.
- Baseline approval remains explicit.
- Implementation tickets are prohibited while baseline-blocking research is open.
- References are progressively disclosed and paths resolve from the skill directory.

**Out of scope:** changing DBZ Spec behavior.

### S12 — Optional DBZ Crew adapter and parallel waves

**Dependencies:** S08–S10.

**Scope:**

- Inspect the current DBZ Crew CLI, skill contract, and event extension before implementation.
- Define and implement the DBZ Workflows executor adapter without duplicating Crew behavior.
- Dispatch eligible tickets and explicit waves.
- Normalize done/blocked/failed results.
- Keep canonical mutation in the coordinator.
- Handle cancellation, worker failure, worktree branches, commit rebases, and result size bounds.
- Keep the adapter unavailable but harmless when DBZ Crew is disabled.

**Expected files:**

```text
agents/pi/extensions/dbz-workflows/executors/dbz-crew.ts
agents/pi/extensions/dbz-workflows/*crew*.test.ts
```

Existing DBZ Crew files MAY be changed only when inspection proves a cohesive integration change is necessary; such changes require their own focused tests.

**Acceptance criteria:**

- Research waves run in parallel up to the confirmed limit.
- Question sessions cannot be dispatched.
- Worker output never directly edits canonical state.
- Adapter absence does not affect manual execution.
- Failures retain actionable diagnostics and safe ticket states.

**Out of scope:** additional executor backends.

### S13 — Verification, final integration, and DBZ Issues adapter

**Dependencies:** S04–S12.

**Scope:**

- Implement `verification.md` creation, staleness, criterion evidence, and outcomes.
- Implement correction-loop transitions.
- Implement awaiting-integration and completed gates.
- Implement confirmed final Git integration plans and containment validation.
- Inspect the current DBZ Issues CLI/schema and implement an adapter rather than direct registry edits.
- Implement issue relations, bidirectional linking, eligibility, explicit closure, and cancelled-workflow behavior.

**Expected files:**

```text
skills/dbz-workflows/lib/verification.mjs
skills/dbz-workflows/lib/issues-adapter.mjs
agents/pi/extensions/dbz-workflows/verification.ts
agents/pi/extensions/dbz-workflows/issues.ts
relevant focused tests
```

Existing DBZ Issues files MAY be changed only when required to provide a supported adapter operation and MUST retain explicit-mutation and terminal-closure safety.

**Acceptance criteria:**

- Changed commits or baselines invalidate verification.
- Failed verification returns to execution through explicit tickets.
- `completed` requires target-branch containment for project changes.
- Only `resolves` links become closure-eligible.
- No issue closes without explicit confirmation.
- Partial and cancelled workflows behave as specified.

**Out of scope:** GitHub, GitLab, or other remote issue trackers.

### S14 — Package wiring, documentation, end-to-end tests, and release readiness

**Dependencies:** S01–S13.

**Scope:**

- Add skill and extension resources to package allowlists and Pi manifest.
- Update the package setup feature selection so DBZ Workflows skill and extension enable cohesively.
- Ensure optional DBZ Crew integration is enabled only when its resources are available.
- Update README, package documentation, and packed-file expectations.
- Add installation/update smoke tests and end-to-end workflow tests using isolated HOME and disposable Git repositories.
- Run full repository checks and `npm pack --dry-run` validation.
- Add a Changeset describing the user-visible feature.

**Expected files:**

```text
package.json
README.md
skills/dbz-ai-tools-setup/...
tests/...
.changeset/<generated-name>.md
```

**Acceptance criteria:**

- `pi install npm:@debonzi/dbz-ai-tools` exposes the resources when enabled.
- `pi update --extensions` updates code without modifying project or user workflow state.
- Existing selective resource filters remain safe.
- The packed archive contains all and only intended runtime resources.
- The complete test suite and package checks pass.

**Out of scope:** publishing the release itself unless separately requested.

## 23. Recommended implementation-session prompt

Use this form for each clean implementation session:

```text
Read every applicable AGENTS.md file and docs/specs/dbz-workflows.md completely.
Implement only session SXX from the implementation index. Follow all General
Implementation Rules, dependencies, acceptance criteria, and testing
requirements. Inspect the current repository and relevant installed Pi docs
before coding. Do not implement later sessions except for explicitly required
scaffolding. Report changed files, tests run, and any blocker against the spec.
```

## 24. Completion definition for the component

DBZ Workflows V1 is implementation-complete only when:

- all S01–S14 acceptance criteria pass;
- the npm package installs and selectively enables the skill and extension;
- all three storage modes pass end-to-end tests;
- a workflow can progress through discovery, baseline, decomposition, manual ticket execution, verification, and completion;
- baseline-blocking research and synthesis behavior is enforced;
- optional DBZ Crew execution works when enabled and degrades safely when absent;
- DBZ Issues linkage never closes an issue without confirmation;
- package and repository validation pass;
- no credentials, runtime state, caches, histories, or trust data are included in the repository or package.
