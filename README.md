# DBZ AI Tools

Skills, extensions, tools, and configuration for the Pi coding agent.

## Contents

- `skills/`: Agent Skills packages, including their scripts and references.
- `agents/pi/`: Pi-specific extensions and system instructions.
- `issues/`: local file-based issues intended for AI-agent workflows.

## Install the Pi package

Requirements: Pi 0.83.0 or newer and Python 3. DBZ Crew additionally requires Git and Herdr with Pi worker support.

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

Setup lets you choose global or project-local resource filters, select the skills to enable, and optionally enable `codex-usage`. The setup skill always remains enabled. Selecting `dbz-crew` also enables `dbz-crew-events` and offers to run the separately confirmed official integration command:

```bash
herdr integration install pi
```

Finish with `/reload` or restart Pi. Package files are managed as one bundle; selection controls which resources Pi loads rather than which files are downloaded.

Update unpinned packages with:

```bash
pi update --extensions
```

Existing allowlists keep skills introduced by an update disabled until `/skill:dbz-ai-tools-setup` is run again.

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
