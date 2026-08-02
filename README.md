# DBZ AI Tools

Skills, extensions, tools, and configuration for the Pi coding agent.

## Contents

- `configs/`: shared agent instructions and Linux work-environment configuration.
- `skills/`: portable skills following the Agent Skills format.
- `tools/`: shared command-line workflows such as DBZ Crew.
- `issues/`: local file-based issues intended for AI-agent workflows.
- `agents/pi/`: Pi-specific extensions and resource directories.

## Install

Choose exactly one installation target per invocation:

```bash
./install.sh configs
./install.sh pi
```

The installer validates all prerequisites and destinations before creating
symlinks. It does not install applications or other dependencies, and it
refuses to overwrite unexpected files or symlinks.

### Linux work environment

`./install.sh configs` requires Linux, Zsh, WezTerm, Starship, and Herdr. It
validates and links the repository-owned files individually:

```text
configs/wezterm/wezterm.lua     -> ${XDG_CONFIG_HOME:-$HOME/.config}/wezterm/wezterm.lua
configs/starship/starship.toml  -> ${XDG_CONFIG_HOME:-$HOME/.config}/starship.toml
configs/herdr/config.toml       -> ${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml
```

The command automatically replaces only recognized legacy links from a sibling
`dbz-toolbox` checkout. Existing regular files, unrelated links, linked
configuration directories, and broken unexpected links cause validation to
fail before any changes. Repeated installation is idempotent.

Only the individual configuration files are linked, so application logs and
runtime state remain outside the repository. Applications that rewrite a
linked configuration file will modify this checkout. See the
[official Herdr configuration documentation](https://herdr.dev/docs/configuration/)
for Herdr-specific behavior.

### Pi

Requires `pi`, `python3`, `git`, and `herdr`. The installer:

- links `configs/AGENTS.md` to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md`;
- keeps the global `skills/`, `extensions/`, `prompts/`, and `themes/` paths as
  real directories and links each repository resource individually;
- links the shared `dbz-crew` CLI into `~/.local/bin`;
- installs Herdr's official Pi integration.

Existing third-party resources are preserved. Legacy whole-directory links from
this repository are migrated only when their targets match exactly. Pi owns its
mutable global `settings.json`; this repository does not link or manage it. A
readable legacy settings link is converted to a private real file. If that link
is already broken, replace it with a real settings file before rerunning the
installer.

## DBZ Crew

DBZ Crew delegates explicitly requested tasks from Pi to Pi workers. Workers
inherit the principal's provider, model, and thinking level. Strict clean-`main`
checks protect implementation workers. Explicitly read-only workers may inspect
dirty or non-main source worktrees through an isolated snapshot, with an opt-in
live-worktree mode. See [`tools/dbz-crew/README.md`](tools/dbz-crew/README.md) for
the command matrix and safety behavior.

## Local issue management

The portable `dbz-issues` skill manages Markdown issue registries under
`issues/open/` and `issues/closed/`. Its dependency-aware Python CLI can
initialize a selected registry, create and edit open issues, report actionable
issues, and close completed work. Initialization and every mutation require an
explicit user request; closed issues are terminal and immutable.

## Security

Credentials and agent-generated state are intentionally excluded. Review all
skills and extensions before installing them: they run with the permissions of
the local user or can instruct an agent to execute commands.

## License

MIT
