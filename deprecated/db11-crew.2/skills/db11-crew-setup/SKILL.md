---
name: db11-crew-setup
description: Diagnose and configure the local DB11 Crew Pi integration. Use when the requester asks to inspect readiness, review or edit validated DB11 Crew settings, understand activation and exact-session reload, or explicitly set up the official Herdr Pi integration.
license: MIT
compatibility: Requires DB11 Crew 0.2.0 on supported local Linux; mutation commands require interactive Pi UI.
metadata:
  version: "0.2.0"
---

# DB11 Crew setup

Setup is explicit, local, and read-only first. Never install or update packages, change Pi trust, alter package filters, edit project files, store secrets, activate or reload a session, clean resources, roll back code or packages, publish, or improvise setup through shell commands.

## Progressive disclosure

Read only the references needed:

- [Diagnostics](references/diagnostics.md) for readiness and stale integration checks.
- [Settings](references/settings.md) for validated account configuration.
- [Herdr integration](references/herdr-integration.md) for the separately confirmed official integration flow.
- [Activation and reload](references/activation-reload.md) for canonical diagnosis, explicit activation, exact-session restoration, failure states, and current-resource persistence.
- [Reference index](references/README.md) when the operation is unclear.

## Commands

- `/db11-crew-doctor` runs bounded local read-only diagnostics.
- `/db11-crew-settings show` displays only a validated configuration; rejected values remain hidden.
- `/db11-crew-settings edit` starts from validated configuration-v2 defaults, validates allowed limits, retention, progress, and built-in role runtimes, then requires confirmation before a private account-file write. Rejected v1 values remain hidden and are never migrated automatically.
- `/db11-crew-setup` reruns read-only checks and shows the exact optional official Herdr Pi integration command and target without mutation.
- `/db11-crew-setup apply` is valid only after the requester separately authorizes that exact plan. The interactive command asks again before running only `herdr integration install pi`, then verifies status.

Do not treat invocation of this skill, a diagnosis request, package installation, project trust, activation, or reload as authorization for setup or another live operation. Setup, reload, activation, integration, cleanup, rollback, publication, remote access, and private-service access each require their own applicable explicit authorization. If there is no interactive UI, provide the read-only report and stop before mutation.

See the package [operational guide](../../docs/operations.md) for installation, trust, support, canonical diagnosis, activation, reload, safe operations, non-goals, and persistence boundaries.
