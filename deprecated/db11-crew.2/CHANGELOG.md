# @debonzi/db11-crew

## 0.2.0

- Restore DB11 Crew as a source-only local Linux Pi package with separate Crewlead and authenticated member-companion entry points.
- Add strict version-1 durable and control-plane contracts, private v2 state, fenced leases and capabilities, lifecycle services, Git isolation, Herdr protocol 17/schema 1 integration, asynchronous dispatch, delivery, recovery, retention, and explicit integration/cleanup controls.
- Recognize the lazily materialized `runtime/{sessions,workspaces}` subtree as canonical managed state so authenticated member companions can reopen state after Crewlead allocation without weakening unknown-entry checks.
- Add selective version-2 account configuration, member profile manifest, companion configuration, and Scout, Planner, and Builder role profiles while retaining the accepted version-1 task, run, event, result, delivery, lease, capability-record, and stored-state contracts.
- Adopt cooperative role policy: profiles and immutable task packets govern behavior without claiming ambient-tool allowlists, same-user containment, credential or network isolation, root confinement, scoped replacement adapters, or guaranteed web access.
- Reduce the member companion to authenticated blocker and finalization tools while preserving provenance, identity, lease, revision/fencing, amendment, cancellation, immutable-result, and session-switch/fork controls.
- Remove obsolete role replacement adapters, member launch and web guards, active-tool inventories, provider-route inventories, and the packaged web dependency and its production closure.
- Add prominent same-user filesystem, credential, process, network, private-service, package, Git/Wyrd, trusted-startup, and external-side-effect warnings; snapshots and worktrees are workflow and evidence contexts, not security sandboxes.
- Add read-only-first diagnostics, explicit manual configuration-v2 replacement, separately confirmed official Herdr Pi integration setup, and progressive Crew and setup guidance.
- Use only the canonical state root `~/.local/state/db11-crew`, marker identity `db11-crew`, and Builder ref pattern `refs/heads/db11-crew/<run-id>` for current resources while preserving independent configuration, profile, companion, core/result, and package version axes.
- Replace obsolete cutover guidance with canonical-only diagnosis, explicit activation as the first mutation, fenced same-session designation, exact-session reload and restoration, designated-unavailable failure handling, persistent current resources, and separate setup, reload, integration, cleanup, rollback, and publication authority.
