# @debonzi/db11-skills

A Pi package for durable topic-by-topic planning, staged development journeys, and implementation-ready specification workflows.

## Included skills

| Skill | Purpose | Prerequisites |
| --- | --- | --- |
| [`db11-plan`](skills/db11-plan/SKILL.md) | Run an explicitly invoked, durable topic-by-topic planning and decision session | Wyrd CLI 0.1.x |
| [`db11-journey`](skills/db11-journey/SKILL.md) | Run Definition, Planning, and Implementation across sessions with durable Wyrd state | Wyrd CLI 0.1.x |
| [`db11-spec`](skills/db11-spec/SKILL.md) | Guide discovery and produce an implementation-ready specification | No external executable |

`db11-plan` and `db11-journey` use compact routing skills and progressively load only the operation and protocol references relevant to the current session. Neither initializes Wyrd nor delegates DB11 Crew members automatically. DB11 Plan uses one standalone Plan Ticket and one child task per Plan Topic; DB11 Journey uses a dependency-linked phase lifecycle.

All three skills include their OpenAI agent metadata under their respective `agents/` directories.

## Install

This repository defines the npm package identity and release configuration, but it does not establish current registry publication. When the package is available on npm, install it with:

```sh
pi install npm:@debonzi/db11-skills
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/db11-skills
```

Pi discovers all three skills under the declared `skills` resource by default. Use `pi config` to control global resource loading or `pi config -l` for project overrides.

Run `/skill:db11-plan start <problem>` to create a standalone Plan Ticket and begin its first Plan Topic, `/skill:db11-plan resume <ticket-id>` to continue from durable Wyrd state, `/skill:db11-plan status <ticket-id>` for a read-only checkpoint, or `/skill:db11-plan conclude <ticket-id>` to synthesize an accepted Plan Conclusion. DB11 Plan requires explicit invocation.

Run `/skill:db11-journey start <codename>` to start a Journey, `/skill:db11-journey resume <codename>` to recover its bounded current context, or `/skill:db11-journey advance <codename>` to perform an explicitly requested phase transition. Run `/skill:db11-spec` for standalone specification discovery. Pi may load other enabled skills when their descriptions match the request.

## Upgrade note

The former `db11-issues` skill and its bundled Markdown registry CLI are no longer distributed. Updating the package does not modify existing registry files.

## Migrate from the former DBZ package

The package and retained specification skill have new Pi identities:

| Former identity | Current replacement |
| --- | --- |
| `@debonzi/dbz-skills` | `@debonzi/db11-skills` |
| `dbz-issues` / `/skill:dbz-issues` | No replacement; the issue-management skill is retired |
| `dbz-spec` / `/skill:dbz-spec` | `db11-spec` / `/skill:db11-spec` |

There are no temporary aliases for the former package or skill names. Migrate explicitly after the DB11 npm package is available:

1. Run `pi list` in each relevant project. Under `User packages` (global) and `Project packages` (project-local), find the former source and copy the source value before any `(filtered)` status marker, including an npm version or Git ref when present. For a local source, use the resolved absolute path that Pi prints below it when removing; a relative local source in settings is not necessarily relative to the shell directory. If the package exists in both scopes, remove both entries separately.
2. Pass the copied npm or Git source, or the resolved local path, to `pi remove`, using `-l` only for a project-local entry. For the common unpinned npm source, the commands are:

   ```sh
   # Global installation
   pi remove npm:@debonzi/dbz-skills

   # Project-local installation
   pi remove npm:@debonzi/dbz-skills -l
   ```

   Use these literal commands only when `pi list` reports `npm:@debonzi/dbz-skills`; otherwise substitute the exact reported source.
3. Install the DB11 npm package in the intended scope when you need `db11-plan`, `db11-journey`, or `db11-spec`:

   ```sh
   # Global installation
   pi install npm:@debonzi/db11-skills

   # Project-local installation
   pi install npm:@debonzi/db11-skills -l
   ```

4. Review global loading with `pi config` and project overrides with `pi config -l`. Package filters and enabled-resource choices do not transfer automatically. Configure `db11-plan`, `db11-journey`, and `db11-spec` explicitly where needed and remove stale issue-skill filters; project overrides can still affect a global installation.
5. Run `/reload` in every running Pi session that should use the new package, or restart those sessions, after removal, installation, and filter changes.

## Develop and test

From a full repository source checkout:

```sh
cd packages/db11-skills
npm pack --dry-run --ignore-scripts
```

Repository-only validation files are not included in the package tarball. Run `npm run check` and `npm run pack:check` from the repository root for the complete workspace validation. Use the [DB11 Plan smoke test](https://github.com/debonzi/db11-ai-tools/blob/main/packages/db11-skills/tests/SMOKE_DB11_PLAN.md) for the manual start, clarification, acceptance, resume, status, and conclusion workflow.

## License

MIT
