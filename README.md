# DBZ AI Tools

Skills, extensions, tools, and configuration for the Pi coding agent.

## Contents

- `skills/`: Agent Skills packages, including their scripts and references.
- `agents/pi/`: Pi-specific extensions and system instructions.
- `configs/`: shared agent instructions and Linux work-environment configuration.
- `issues/`: local file-based issues intended for AI-agent workflows.

## Install the Pi package

Requirements: Pi 0.83.0 or newer and Python 3. DBZ Workflows requires a non-shallow Git worktree with at least one commit and one reachable root. DBZ Crew additionally requires Git and Herdr with Pi worker support.

Install the public package from npm:

```bash
pi install npm:@debonzi/dbz-ai-tools
```

Pin a specific version when reproducibility is more important than automatic package updates:

```bash
pi install npm:@debonzi/dbz-ai-tools@0.1.0
```

For a project-local package installation:

```bash
pi install -l npm:@debonzi/dbz-ai-tools
```

Start or restart Pi, then run the explicit setup skill:

```text
/skill:dbz-ai-tools-setup
```

Setup lets you choose global or project-local resource filters, select the skills to enable, and optionally enable `codex-usage`. The setup skill always remains enabled. Selecting `dbz-workflows` enables its Pi extension as one cohesive feature. Selecting `dbz-crew` also enables `dbz-crew-events` and offers to run the separately confirmed official integration command:

```bash
herdr integration install pi
```

Finish with `/reload` or restart Pi. Package files are managed as one bundle; selection controls which resources Pi loads rather than which files are downloaded.

Update unpinned packages with:

```bash
pi update --extensions
```

Existing allowlists keep skills and paired extensions introduced by an update disabled until `/skill:dbz-ai-tools-setup` is run again. Package updates replace package code only; DBZ Workflows project artifacts, external storage, locators, locks, and claims remain outside the npm-managed checkout.

Use `pi config` for Pi's native resource configuration UI and `pi remove npm:@debonzi/dbz-ai-tools` to remove the package. Removing the package does not uninstall the shared Herdr Pi integration.

### Source installation and npm migration

The default Git branch remains available for source-based testing:

```bash
pi install git:github.com/debonzi/dbz-ai-tools
```

Pi treats Git and npm sources as different packages. To migrate an existing rolling Git installation without loading both copies, remove the Git source before installing the npm package:

```bash
pi remove git:github.com/debonzi/dbz-ai-tools
pi install npm:@debonzi/dbz-ai-tools
```

Run `/skill:dbz-ai-tools-setup` again to recreate the desired resource filters.

## Migrate an installation created by the old Pi installer

The previous `./install.sh pi` command linked package resources directly into Pi's global directories. Remove only recognized links before installing the package; never remove regular files, third-party resources, or links with unexpected targets.

1. Stop active Pi sessions and update this checkout.
2. Inspect the legacy paths with `readlink`:
   - `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/dbz-crew`
   - `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/dbz-issues`
   - `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/dbz-spec`
   - `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/dbz-crew-events`
   - `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/codex-usage`
   - `$HOME/.local/bin/dbz-crew`
3. Unlink a listed path only when it points to the corresponding resource in this checkout. If the complete legacy `skills` or `extensions` directory is itself a symlink, unlink it only when its target is exactly this repository's matching resource directory.
4. Preserve the Herdr-managed `herdr-agent-state.ts`, Pi's real `settings.json`, unrelated resources, and `~/.local/state/dbz-crew`.
5. Before `pi install`, inspect `settings.json`. If it is still a legacy repository symlink, copy its dereferenced content to a private temporary regular file, verify the copy, replace only that recognized symlink, and keep mode `0600`. Refuse broken or unexpected links.
6. Run `./install.sh configs` to retain the global agent instructions, then follow the package installation and setup steps above.

This migration is intentionally manual so package installation never guesses which user-owned paths it may remove.

## Linux work-environment configuration

`./install.sh configs` requires Linux, Pi, Zsh, WezTerm, Starship, and Herdr. It validates every prerequisite, source, and destination before creating symlinks:

```text
configs/wezterm/wezterm.lua     -> ${XDG_CONFIG_HOME:-$HOME/.config}/wezterm/wezterm.lua
configs/starship/starship.toml  -> ${XDG_CONFIG_HOME:-$HOME/.config}/starship.toml
configs/herdr/config.toml       -> ${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml
configs/AGENTS.md               -> ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md
agents/pi/APPEND_SYSTEM.md      -> ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/APPEND_SYSTEM.md
```

The command automatically replaces only recognized work-environment links from a sibling `dbz-toolbox` checkout. Existing regular files, unrelated links, linked destination directories, broken unexpected links, and invalid source configurations cause validation to fail before any changes. Repeated installation is idempotent.

Only the individual configuration files are linked, so application logs and runtime state remain outside the repository. Applications that rewrite a linked configuration file will modify this checkout. See the [official Herdr configuration documentation](https://herdr.dev/docs/configuration/) for Herdr-specific behavior.

## DBZ Workflows

DBZ Workflows manages durable discovery and delivery as human-readable Markdown artifacts backed by deterministic core operations. It supports project-local, managed external, and exact user-selected external storage; approved specification baselines; dependency-aware tickets; isolated manual execution sessions; verification; and confirmed final Git integration.

After enabling `dbz-workflows` through package setup, configure each Git project separately:

```text
/dbz-workflows-setup
/dbz-workflows
```

Project setup validates Git identity and storage on every operation and never commits setup changes silently. The optional DBZ Crew executor is registered only when its bundled cohesive CLI resource is available; manual execution remains available without it. See [`agents/pi/extensions/dbz-workflows/README.md`](agents/pi/extensions/dbz-workflows/README.md) for the command and safety surface.

## DBZ Crew

DBZ Crew delegates explicitly requested tasks from Pi to Pi workers. Workers inherit the principal's provider, model, and thinking level. Strict clean-`main` checks protect implementation workers. Explicitly read-only workers may inspect dirty or non-main source worktrees through an isolated snapshot, with an opt-in live-worktree mode.

The CLI is bundled at `skills/dbz-crew/scripts/dbz-crew`; no global `dbz-crew` executable is installed. Agents resolve and invoke it through the skill. See [`skills/dbz-crew/references/CLI.md`](skills/dbz-crew/references/CLI.md) for the command matrix and safety behavior.

## Local issue management

The portable `dbz-issues` skill manages Markdown issue registries under `issues/open/` and `issues/closed/`. Its dependency-aware Python CLI can initialize a selected registry, create and edit open issues, report actionable issues, and close completed work. Initialization and every mutation require an explicit user request; closed issues are terminal and immutable.

## Codex usage configuration

The managed package checkout must not be edited for local configuration. Optional `codex-usage` overrides live at:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/codex-usage.json
.pi/codex-usage.json
```

Project overrides are loaded only for trusted projects. See [`agents/pi/extensions/codex-usage/README.md`](agents/pi/extensions/codex-usage/README.md).

## Releases

Published releases use Changesets, annotated Semantic Versioning tags, GitHub environment approval, and npm trusted publishing with provenance. Maintainers should follow [`docs/releasing.md`](docs/releasing.md); contributors should add a Changeset with `npx changeset` for every user-visible package change.

## Security

Pi packages run with the permissions of the local user. Review all skills, scripts, and extensions before installation. The package has no `install` or `postinstall` lifecycle script and never silently installs the Herdr integration or other software.

Credentials and agent-generated state are intentionally excluded from this repository.

## Validation

Install the locked development dependencies and run the same checks used by CI and release validation:

```bash
npm ci
npm run check
npm run pack:check
```

## License

MIT
