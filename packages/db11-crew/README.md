# @debonzi/db11-crew

DB11 Crew delegates explicitly requested work from Pi to Herdr-managed Pi workers. It is intended for interactive Pi sessions in Git repositories where the requester has explicitly asked for delegation or parallel work.

The [`db11-crew` skill](skills/db11-crew/SKILL.md), its bundled [CLI and reference](skills/db11-crew/references/CLI.md), the explicit [`db11-crew-setup` skill](skills/db11-crew-setup/SKILL.md), and the [`db11-crew-events` extension](agents/pi/extensions/db11-crew-events/README.md) form one package. They are intentionally released together because they share a private state protocol, completion-event schema, security model, and lifecycle contract.

## Requirements

- Pi 0.83.0 or newer;
- Python 3;
- Git;
- Herdr with Pi worker and integration support;
- the official Herdr Pi integration.

The setup and runtime preflight checks validate required Herdr capabilities rather than relying only on version numbers. The event extension is active only in an interactive, Herdr-managed Pi process.

## Install and set up

Install the published package:

```sh
pi install npm:@debonzi/db11-crew
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/db11-crew
```

Pi loads both DB11 Crew skills and the event extension by default. Use `pi config` or `pi config -l` to control installed resources, but complete DB11 Crew event delivery requires the skill and extension together.

After installation, explicitly invoke the setup workflow when prerequisite or integration guidance is needed:

```text
/skill:db11-crew-setup
```

The setup skill performs read-only prerequisite and capability checks first, then presents the complete plan before any mutation. It requires a separate explicit confirmation before running the official `herdr integration install pi` command. It never installs unrelated software, changes Pi trust decisions, or edits package filters. Run `/reload` or restart Pi when setup makes the package or integration available to the current session.

## Safety and state

DB11 Crew dispatches workers only after an explicit delegation request. Implementation workers use isolated Git worktrees and strict clean-`main` checks. Explicitly read-only workers use isolated snapshots by default, with live-worktree access available only on explicit request.

The bundled CLI is not installed in `PATH`; agents resolve it through the skill. Completion events, prompts, and results remain private local state under `~/.local/state/db11-crew`. The event extension validates event ownership, session identity, file type, and state-root boundaries before follow-up delivery.

See the [CLI reference](skills/db11-crew/references/CLI.md) for command and lifecycle details. The [manual smoke test](https://github.com/debonzi/db11-ai-tools/blob/main/packages/db11-crew/tests/SMOKE_DB11_CREW.md) is repository-only.

## Migrate from the former DBZ runtime

DB11 Crew is a hard namespace cutover with no compatibility window or protocol bridge. Before switching packages, let former DBZ Crew workers finish or clean them up with the old CLI. Then remove the exact old package source reported by `pi list`, install `@debonzi/db11-crew`, review package filters for the `db11-crew`, `db11-crew-setup`, and `db11-crew-events` resources, and run `/reload` or restart Pi.

The DB11 runtime uses new state, protocol, and worker identities. It does not read, merge, move, chmod, or delete legacy `~/.local/state/dbz-crew` data; it ignores former `DBZ_CREW_*` variables, `dbz-crew-event` records, delivered markers, result sentinels, and worker branches. If legacy and DB11 state both exist, DB11 Crew operates only on `~/.local/state/db11-crew` and applies its ownership, permission, normalization, anti-symlink, and worktree-isolation checks independently. An unsafe DB11 path fails closed without touching the legacy tree.

This separation makes the transition idempotent and preserves rollback: stop DB11 workers, remove the DB11 package source, reinstall the former package if it is still available, restore its resource filters, and reload Pi. The former runtime continues to see its untouched state. Never run both namespaces concurrently against the same repository, and archive or remove either state tree only through a separately reviewed manual operation.

## Develop and test

These deterministic tests do not require live Herdr access. Run them from a full repository source checkout:

```sh
cd packages/db11-crew
python3 -m unittest discover -s skills/db11-crew/tests -v
TZ=UTC node --test agents/pi/extensions/db11-crew-events/index.test.ts
```

Run `npm run check` and `npm run pack:check` from the repository root for package-structure and workspace validation.

## License

MIT
