# DBZ AI Tools

Shared skills, extensions, tools, and configuration for AI coding agents, with
a primary focus on Pi.

## Contents

- `configs/`: global instructions shared by supported agents.
- `skills/`: portable skills following the Agent Skills format.
- `agents/pi/`: Pi settings and resource directories.
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

Requires `pi`. The installer links:

- `configs/AGENTS.md` to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md`;
- `agents/pi/settings.json` as the global settings file;
- shared `skills/` and the Pi-specific `extensions/`, `prompts/`, and `themes/`
  directories.

Packages declared in `settings.json` are resolved by Pi itself.

### Codex

Requires `codex`, `python3`, `git`, and `herdr`. The installer links:

- `configs/AGENTS.md` to `${CODEX_HOME:-$HOME/.codex}/AGENTS.md`;
- each shared skill into the Codex skills directory;
- `dbz-crew` into `~/.local/bin`.

It also registers the `dbz-ai-tools` marketplace and installs the
`dbz-crew@dbz-ai-tools` plugin.

## Security

Credentials and agent-generated state are intentionally excluded. Review all
skills and extensions before installing them: they run with the permissions of
the local user or can instruct an agent to execute commands.

## License

MIT
