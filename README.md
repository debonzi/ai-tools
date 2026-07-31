# DBZ AI Tools

Shared skills, extensions, tools, and configuration for AI coding agents, with
a primary focus on Pi.

## Contents

- `configs/`: global instructions shared by supported agents.
- `skills/`: portable skills following the Agent Skills format.
- `tools/`: shared command-line workflows such as DBZ Crew.
- `agents/pi/`: Pi-specific extensions and resource directories.
- `agents/codex/`: Codex-specific plugins and integrations.
- `.agents/plugins/marketplace.json`: the local Codex marketplace manifest.

## Install

Choose exactly one agent per invocation:

```bash
./install.sh pi
./install.sh codex
```

The installer validates all prerequisites and destinations before creating
symlinks. It does not install agent CLIs or other dependencies, and it refuses
to overwrite unexpected files or symlinks.

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

### Codex

Requires `codex`, `python3`, `git`, and `herdr`. The installer links:

- `configs/AGENTS.md` to `${CODEX_HOME:-$HOME/.codex}/AGENTS.md`;
- each shared skill into the Codex skills directory;
- the shared `dbz-crew` CLI into `~/.local/bin`.

It also registers the `dbz-ai-tools` marketplace and installs the
`dbz-crew@dbz-ai-tools` adapter plugin. DBZ Crew workers inherit the principal
agent kind; Pi workers additionally inherit provider, model, and thinking level.

DBZ Crew uses strict clean-`main` checks for implementation workers. Explicitly
read-only workers may inspect dirty or non-main source worktrees through an
isolated snapshot, with an opt-in live-worktree mode. See
[`tools/dbz-crew/README.md`](tools/dbz-crew/README.md) for the command matrix and
safety behavior.

## Security

Credentials and agent-generated state are intentionally excluded. Review all
skills and extensions before installing them: they run with the permissions of
the local user or can instruct an agent to execute commands.

## License

MIT
