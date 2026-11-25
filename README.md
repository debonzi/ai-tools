# DB11 AI Tools package catalog

This repository is the private workspace coordinator and source catalog for independently installable [Pi](https://github.com/earendil-works/pi-mono) packages. The repository root is not a Pi package and is never published.

## Packages

| Package | Included resources | Intended use |
| --- | --- | --- |
| [`@debonzi/pi-codex-usage`](packages/pi-codex-usage/README.md) | Codex Usage Pi extension | OpenAI Codex quota display and on-demand usage reports |
| [`@debonzi/pi-context-meter`](packages/pi-context-meter/README.md) | Pi Context Meter extension | On-demand reports of context-window usage and remaining capacity |
| [`@debonzi/pi-copilot-usage`](packages/pi-copilot-usage/README.md) | GitHub Copilot Usage Pi extension | GitHub Copilot allowance display and on-demand usage reports |

Package versions and releases are independent. There is no aggregate package that installs them together.

## Install from npm

This repository defines the npm package identities and release configuration, but it does not establish current registry publication. When a selected package is available on npm, review its source before installation: Pi extensions execute code.

Install only the packages you want:

```sh
pi install npm:@debonzi/pi-codex-usage
pi install npm:@debonzi/pi-context-meter
pi install npm:@debonzi/pi-copilot-usage
```

`pi install` installs a complete package and enables its declared resources by default. It writes to global settings unless `-l` is supplied for a project-local installation. Use `pi config` to control globally loaded resources, or `pi config -l` to start in project overrides with inherited global resources shown dimmed.

If Pi is already running after an install or configuration change, run `/reload` or restart Pi. Unpinned packages can be updated with `pi update --extensions`.

## Deprecated resources

| Archived resource | Status |
| --- | --- |
| [`@debonzi/db11-skills`](deprecated/db11-skills/README.md) | `db11-plan`, `db11-shipit`, and `db11-journey` are deprecated. The package is no longer an active workspace or release target. |
| [`context-footer`](deprecated/context-footer.ts) | The local Pi extension has been removed from `agents/pi/extensions/`. |
| [`db11-squad`](deprecated/db11-squad/ANOTATIONS.md) | The proposal is retired. Only architectural notes were present; there was no runnable extension to remove. |

The archives are kept for reference. This change does not modify existing Pi installations, Wyrd records, or npm registry metadata. `db11-issues` and `db11-spec` had already been retired and are not distributed by any active package.

### Remove a retired standalone skills package

Run `pi list` to identify any installed `@debonzi/db11-skills` or `@debonzi/dbz-skills` source. There is no replacement skills package in this repository. Pass the exact source shown (including any version pin, Git ref, or resolved local path) to `pi remove`. Use `-l` for project-local entries; if a source is installed in both scopes, remove each entry separately. Reload or restart Pi afterward.

If you loaded `context-footer` by an explicit path, remove that path from your Pi configuration or launch command.

## Migrate from the former aggregate package

There is no automatic migration from `@debonzi/dbz-ai-tools` and no aggregate `@debonzi/db11-ai-tools` package. Of the former resources, only `codex-usage` has a replacement: `@debonzi/pi-codex-usage`. The former issues, spec, and crew resources have no replacement in this repository.

1. Run `pi list` to identify the old source. Use `pi config` or `pi config -l` to review intentional filters and overrides before removing it.
2. Run `pi remove` with the exact old source, such as `npm:@debonzi/dbz-ai-tools` or `git:github.com/debonzi/dbz-ai-tools`. Use `-l` for project-local entries.
3. Install the replacement if needed. Old filters do not transfer to a new package identity; check what Pi loads with `pi config` or `pi config -l`, then reload or restart Pi.

## Develop from source

From a clone of this repository, install an active workspace by its explicit local path:

```sh
pi install ./packages/pi-codex-usage
pi install ./packages/pi-context-meter
pi install ./packages/pi-copilot-usage
```

Local paths reference the source workspaces directly. The private repository root is not installable, and Pi has no documented Git-subdirectory package selector; a Git installation of the repository root does not select one of these packages.

Install locked development dependencies and run the supported repository checks:

```sh
npm ci
npm run check
npm run pack:check
```

See each package README for focused tests. Maintainers should also read the [independent release contract](docs/releasing.md), the [Changesets guidance](.changeset/README.md), and the [historical aggregate-package changelog](CHANGELOG.md).

## Security

No active package has an install or postinstall lifecycle script. Credentials, sessions, histories, caches, trust decisions, and other machine state are excluded from the distributions.

## License

MIT
