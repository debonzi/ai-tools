# @debonzi/dbz-crew

DBZ Crew delegates explicitly requested work from Pi to Herdr-managed Pi workers. It is intended for interactive Pi sessions in Git repositories where the requester has explicitly asked for delegation or parallel work.

The [`dbz-crew` skill](skills/dbz-crew/SKILL.md), its bundled [CLI and reference](skills/dbz-crew/references/CLI.md), the explicit [`dbz-crew-setup` skill](skills/dbz-crew-setup/SKILL.md), and the [`dbz-crew-events` extension](agents/pi/extensions/dbz-crew-events/README.md) form one package. They are intentionally released together because they share a private state protocol, completion-event schema, security model, and lifecycle contract.

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
pi install npm:@debonzi/dbz-crew
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/dbz-crew
```

Pi loads both DBZ Crew skills and the event extension by default. Use `pi config` or `pi config -l` to control installed resources, but complete DBZ Crew event delivery requires the skill and extension together.

After installation, explicitly invoke the setup workflow when prerequisite or integration guidance is needed:

```text
/skill:dbz-crew-setup
```

The setup skill performs read-only prerequisite and capability checks first, then presents the complete plan before any mutation. It requires a separate explicit confirmation before running the official `herdr integration install pi` command. It never installs unrelated software, changes Pi trust decisions, or edits package filters. Run `/reload` or restart Pi when setup makes the package or integration available to the current session.

## Safety and state

DBZ Crew dispatches workers only after an explicit delegation request. Implementation workers use isolated Git worktrees and strict clean-`main` checks. Explicitly read-only workers use isolated snapshots by default, with live-worktree access available only on explicit request.

The bundled CLI is not installed in `PATH`; agents resolve it through the skill. Completion events, prompts, and results remain private local state under `~/.local/state/dbz-crew`. The event extension validates event ownership, session identity, file type, and state-root boundaries before follow-up delivery.

See the [CLI reference](skills/dbz-crew/references/CLI.md) for command and lifecycle details. The [manual smoke test](https://github.com/debonzi/dbz-ai-tools/blob/main/packages/dbz-crew/tests/SMOKE_DBZ_CREW.md) is repository-only.

## Develop and test

These deterministic tests do not require live Herdr access. Run them from a full repository source checkout:

```sh
cd packages/dbz-crew
python3 -m unittest discover -s skills/dbz-crew/tests -v
TZ=UTC node --test agents/pi/extensions/dbz-crew-events/index.test.ts
```

Run `npm run check` and `npm run pack:check` from the repository root for package-structure and workspace validation.

## License

MIT
