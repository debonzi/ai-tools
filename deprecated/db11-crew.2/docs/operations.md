# DB11 Crew operations

## Supported installation

Load the published package through Pi's normal package mechanism on a supported local Linux account. For development, use an explicitly requested local package path. DB11 Crew is source-only, has no production npm dependencies, and has no install, postinstall, daemon, PATH binary, or project-copy step. It never installs ambient tools or web access.

Installation is passive. It does not authorize setup, reload, activation, integration, cleanup, rollback, publication, or another live operation. If a separately requested installation or configuration change must become visible in a running Pi session, request `/reload` or restart that session separately.

The official Herdr Pi integration is optional and separate. `/db11-crew-setup` shows its exact local plan without mutation; `/db11-crew-setup apply` requires separate authorization and interactive confirmation. Reload remains a separate step after a successful integration write.

## Trust

Trust the package, Pi installation, account configuration, project, ambient extensions, and startup code before activation. Project instructions are task input and cannot grant lifecycle authority or authorize remote hosts, private services, package changes, trust changes, integration, cleanup, rollback, publication, or destructive effects.

Members share the account user's authority. Ambient tools and trusted startup code may access same-user files, credentials, processes, networks, private services, packages, Git, and Wyrd and may cause effects outside DB11 records. Profiles and task packets are cooperative behavioral policy, not containment. Snapshots and worktrees are workflow, ownership, integration, and evidence contexts—not security sandboxes.

## Support matrix

| Component | Supported boundary |
| --- | --- |
| Platform | local Linux |
| Package | `@debonzi/db11-crew` 0.2.0, exact packaged source provenance |
| Pi | tested compatibility descriptor and required APIs |
| Herdr | local protocol 17/schema 1 API and official current Pi integration |
| Git and Wyrd | tested local executable compatibility |
| Roles | built-in Scout, Planner, and Builder profiles v2 |
| Web | ambient account/project capability only; not packaged, required, inventoried, or guaranteed |

Remote Herdr, SSH, containers, cross-agent operation, and unlisted compatibility are not claimed.

## Configuration v2

The optional private file is `~/.config/db11-crew/config.json`. Configuration v2 contains bounded limits, retention, progress, and built-in role runtime overrides. It contains no web-provider setting, tool inventory, extension path, project override, or secret.

Version 1 and unknown schemas are rejected. DB11 Crew does not read rejected values back to the user, migrate them, or rewrite them automatically. Review `config/config.example.json`; then use `/db11-crew-settings edit` to manually create and confirm a validated v2 replacement. Unsafe ownership, type, link, or mode conditions require manual inspection and are never repaired by DB11 Crew. Applying changed settings to a running Pi session requires a separately requested reload or restart.

## Canonical identity and read-only diagnosis

The current implementation uses only these resource identities:

- durable state root `~/.local/state/db11-crew`, including the optional, lazily materialized managed subtree `runtime/{sessions,workspaces}`;
- state-marker identity `db11-crew` with its immutable `storeId`;
- Builder refs matching `refs/heads/db11-crew/<run-id>`.

Canonical-state recognition accepts the runtime subtree only at those exact managed paths and validates each present parent as a private same-user directory. It still rejects unknown root or runtime entries. The runtime subtree may be absent before the first member allocation and remains recognized when only a known parent exists after an interrupted allocation.

`/db11-crew-doctor` performs bounded read-only diagnostics. It classifies only the canonical state as missing and safe for possible later initialization, exactly recognized current state, or blocked by an unsafe or foreign collision. It creates no path, marker, lock, lease, or run; inventories no DB11 Git namespace; and does not inspect other resource locations. A blocked target remains untouched for manual inspection.

Diagnosis is sanitized point-in-time evidence. It does not authorize activation, prove future availability, confer ownership, or replace the fresh role-, run-, operation-, revision-, fencing-, repository-, and resource-specific checks required before later mutations.

## Explicit activation

DB11 Crew remains passive until the requester enters the exact image-free `/skill:db11-crew` input through Pi's direct interactive or RPC channel. Natural language, package installation, setup, trust, project instructions, another session, or extension-originated text cannot authorize activation.

All required nonmutating session, managed-member, trust, live Herdr/session/workspace/repository binding, configuration, package provenance, compatibility, role-resource, canonical Git discovery, and canonical-state inspection checks run first. Opening or initializing canonical state is the first mutation. The runtime then starts fenced before the permanent same-session designation is persisted. Queue promotion, member launch, presentation, and Crewlead tools remain latched until designation succeeds and operations are enabled with fresh readiness.

If preparation fails before initialization, activation makes no mutation. If initialization or fenced startup succeeds but designation does not, the valid canonical store remains current and reusable while the session remains undesignated; runtime resources are stopped or fenced. If a later stage fails after designation, the marker remains permanent, the exact session is designated but unavailable, and Crewlead tools remain inactive. Repeating the activation input does not transfer ownership or retry an unavailable designated runtime.

## Exact same-session reload and restoration

A separately requested `/reload`, `/resume`, or Pi restart can run the lifecycle again for a persistent session. Only an exact same-session designation is restored. New, forked, cloned, copied, different, and managed-member sessions never inherit it.

On same-session restoration, DB11 Crew repeats current readiness, fencing, and exact-resource reconciliation. It does not append another designation, transfer ownership, relaunch an exact existing member, or resubmit acknowledged work merely because the extension reloaded. If readiness still fails, the session remains designated but unavailable and current resources remain untouched.

Reload is not setup, activation of another session, integration, cleanup, rollback, or publication authority. Request each operation independently.

## Current-resource persistence

Closing a Herdr tab does not erase its persistent Pi session. Extension shutdown releases active runtime presentation and fencing resources but does not erase canonical state, designation history, durable runs or results, Builder branches or worktrees, member sessions, or Herdr pane history. Herdr history may retain rendered prompts, output, paths, or secrets outside DB11 state.

Durable records remain until a separately designed and authorized exact operation applies. Package removal, source reversal, rollback, reload, result delivery, acknowledgement, or terminal status does not imply resource cleanup. Secure erasure is not claimed.

## Safe operations

Use read-only list and inspection operations first. Require the current responsible human to authorize each exact force cancellation, local fast-forward integration, runtime closure, unmerged-artifact discard, cleanup, package change, rollback, reload, publication, remote access, private-service access, or other external effect. Preserve exact Crewlead session, workspace, project, run revision, fencing, canonical repository, and recorded resource identity. Never infer ownership from a canonical path or namespace alone.

## Non-goals

DB11 Crew does not provide OS sandboxing, same-user containment, credential or network isolation, ambient-tool allowlists, role-specific replacement adapters, guaranteed web access, automatic delegation, recursive orchestration, remote or multi-host execution, package installation, trust mutation, remote Git/PR operations, automatic integration or cleanup, compatibility handling for earlier implementations, secure erase, or broad-platform support.
