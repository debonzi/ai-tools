# DB11 AI Tools package catalog

This repository is the private workspace coordinator and source catalog for three independently installable [Pi](https://github.com/earendil-works/pi-mono) packages. The repository root is not a Pi package and is never published.

## Packages

| Package | Included resources | Intended use |
| --- | --- | --- |
| [`@debonzi/db11-skills`](packages/db11-skills/README.md) | `db11-issues` and `db11-spec` skills | Local issue registries and implementation-ready specification workflows |
| [`@debonzi/db11-crew`](packages/db11-crew/README.md) | DB11 Crew skill, bundled CLI and references, explicit setup skill, and required event extension | Explicit delegation from Pi to Herdr-managed Pi workers |
| [`@debonzi/pi-codex-usage`](packages/pi-codex-usage/README.md) | Codex Usage Pi extension | OpenAI Codex quota display and on-demand usage reports |

Package versions and releases are independent. There is no aggregate package that installs all three.

## Install from npm

Review package source before installation: Pi extensions execute code and skills can direct the agent to run bundled scripts.

Install only the packages you want:

```sh
pi install npm:@debonzi/db11-skills
pi install npm:@debonzi/db11-crew
pi install npm:@debonzi/pi-codex-usage
```

`pi install` installs a complete package and enables its declared resources by default. It writes to global settings unless `-l` is supplied for a project-local installation. Use `pi config` to control globally loaded resources, or `pi config -l` to start in project overrides with inherited global resources shown dimmed.

`@debonzi/db11-skills` is intentionally a multi-skill catalog: installing it makes both independently discoverable skills available. DB11 Crew has the opposite boundary for a cohesive feature: its skill, CLI, setup flow, and event extension ship together because they share a private state, event, and lifecycle contract. A script used only through a skill remains bundled with that skill.

If Pi is already running after an install or configuration change, run `/reload` or restart Pi. Unpinned packages can be updated with `pi update --extensions`.

## Migrate from the former aggregate package

The former `@debonzi/dbz-ai-tools` package cannot be migrated automatically into three npm identities. Preserve any intentional local settings and choose the replacement DB11 package or packages explicitly. There is no aggregate `@debonzi/db11-ai-tools` package.

1. Run `pi list`, `pi config`, and, when relevant, `pi config -l` to inspect the old installation and determine which resources you use.
2. Map the former resources to their current packages and identities:

   | Former resources | Current package and resources |
   | --- | --- |
   | `dbz-issues`, `dbz-spec` | `@debonzi/db11-skills`: `db11-issues`, `db11-spec` |
   | `dbz-crew`, its setup flow, CLI, and event extension | `@debonzi/db11-crew`: `db11-crew`, its setup flow, CLI, and event extension |
   | `codex-usage` | `@debonzi/pi-codex-usage`: `codex-usage` |

3. Remove the old source that `pi list` reports:

   ```sh
   pi remove npm:@debonzi/dbz-ai-tools
   ```

   For a former rolling Git installation, remove that source instead:

   ```sh
   pi remove git:github.com/debonzi/dbz-ai-tools
   ```

4. Install only the new npm packages you selected using the commands above.
5. Review the newly loaded resources with `pi config` or `pi config -l`. Old package filters do not transfer to the new package identities, and this repository does not edit user settings or filters automatically.
6. If you installed DB11 Crew and need prerequisite or Herdr integration guidance, explicitly invoke:

   ```text
   /skill:db11-crew-setup
   ```

7. Run `/reload` or restart Pi when appropriate.

Removing the former package does not remove a separately installed Herdr Pi integration.

## Develop from source

From a clone of this repository, install a workspace by its explicit local path:

```sh
pi install ./packages/db11-skills
pi install ./packages/db11-crew
pi install ./packages/pi-codex-usage
```

Local paths reference the source workspaces directly. The private repository root is not installable, and Pi has no documented Git-subdirectory package selector; a Git installation of the repository root does not select one of these packages.

Install locked development dependencies and run the supported repository checks:

```sh
npm ci
npm run check
npm run pack:check
```

See each package README for focused tests. Maintainers should also read the [independent release contract](docs/releasing.md), the [separately authorized external cutover runbook](docs/db11-external-cutover.md), the [Changesets guidance](.changeset/README.md), and the [historical aggregate-package changelog](CHANGELOG.md).

## Security

No package has an install or postinstall lifecycle script. DB11 Crew never installs the Herdr integration without a complete plan and separate explicit confirmation. Credentials, sessions, histories, caches, trust decisions, and other machine state are excluded from the distributions.

## License

MIT
