# @debonzi/db11-crew

DB11 Crew coordinates persistent local Pi sessions for three built-in roles: Scout, Planner, and Builder. It is a source-only Pi package for supported local Linux environments and remains passive until the requester explicitly activates the Crew skill.

## Cooperative trust model

Role profiles and immutable task packets are behavioral policy, not technical containment. Members run as the same operating-system user with ambient Pi tools and trusted startup code. Depending on the account and project configuration, that code may access files, credentials, processes, networks, private services, installed packages, Git, and Wyrd, and may cause external side effects outside the assigned task.

DB11 Crew does not inventory, restrict, or guarantee ambient tools or extensions. It does not provide an OS sandbox, credential isolation, network isolation, root confinement, or scoped replacements for Git, Wyrd, filesystem, execution, or web access. Snapshots and worktrees provide workflow ownership and evidence boundaries only; they are not security sandboxes.

Use DB11 Crew only with trusted package, account, project, extension, and startup code. Separately authorize remote access, private-service access, package installation or updates, trust changes, integration, cleanup, and destructive effects.

## Package surface

The package remains version 0.2.0 and has no production npm dependencies. Pi supplies the declared peer packages. DB11 Crew does not package or install a web extension; ambient web capability may or may not be available and is neither required nor guaranteed.

The package exposes one Crewlead extension and two skills. The member companion is packaged for explicit authenticated member launch but is not an automatically loaded package extension. The companion registers only authenticated blocker and finalization tools.

## Contracts and configuration

Account configuration, member profile manifest, companion configuration, and role profiles use version 2. Core task, run, event, lifecycle, result, delivery, lease, capability-record, and stored-state contracts remain version 1. The canonical durable state root is `~/.local/state/db11-crew`; its lazily materialized managed runtime subtree contains member sessions and workspaces, its marker identity is `db11-crew`, and Builder refs use `refs/heads/db11-crew/<run-id>`.

Configuration is an optional private account file at `~/.config/db11-crew/config.json`. Version 1 and unknown schemas are rejected without displaying values or automatic migration. Review `config/config.example.json`, then use `/db11-crew-settings edit` to manually prepare and confirm a validated version-2 replacement.

## Activation and reload lifecycle

`/db11-crew-doctor` reads only the canonical state and classifies it as missing-safe, exactly recognized current state, or blocked by an unsafe or foreign collision. Its point-in-time report creates no state or lease and does not authorize activation.

Only the requester's exact direct `/skill:db11-crew` input can request activation for the current persistent Pi session. After every required nonmutating readiness check passes, opening or initializing canonical state is the first mutation. The runtime starts fenced before the permanent same-session designation is recorded, and member operations remain disabled until after designation.

A failure after state initialization but before designation preserves valid current state while leaving the session undesignated. A failure after designation leaves that exact session designated but unavailable with Crewlead tools inactive. Repeating the activation input does not retry it; a separately requested `/reload` or `/resume` can recheck readiness and restore only the exact same session without transferring ownership, relaunching members, or resubmitting work.

Installation, settings changes, official Herdr setup, reload, activation, local integration, cleanup, rollback, publication, remote access, and private-service access remain separate authorization boundaries. Current state, Pi sessions, pane history, Builder resources, and durable results persist until their exact separately authorized lifecycle operations run.

## Commands and skills

- `/skill:db11-crew` requests activation in the exact current persistent Pi session.
- `/db11-crew-doctor` runs bounded local read-only canonical-state diagnostics.
- `/db11-crew-settings show|edit` reviews or explicitly replaces validated non-secret account settings.
- `/db11-crew-setup` reviews the optional official Herdr Pi integration plan.
- `/db11-crew-setup apply` requires separate authorization and interactive confirmation.

See [docs/operations.md](docs/operations.md) for installation, trust, compatibility, canonical diagnosis, activation, reload, persistence, safe operations, and non-goals.

## License

MIT
