# AI Tools for Pi

One Git-distributed [Pi](https://pi.dev) package with three extensions. Git and a working Pi installation are required; this package does not need a build, npm publication, or a separate dependency install. It is tested with Pi 1.6.0.

| Extension | What it adds |
| --- | --- |
| [Codex Usage](extensions/codex-usage/) | `/usage-codex` and a quota widget for an authenticated OpenAI Codex account |
| [Context Meter](extensions/context-meter/) | The `pi-context-meter` tool for inspecting context-window usage |
| [Copilot Usage](extensions/copilot-usage/) | `/usage-copilot` and a quota widget for an authenticated GitHub Copilot account |

## Install

### From GitHub (managed by Pi)

```sh
pi install git:github.com/debonzi/ai-tools
```

For GitHub access over SSH instead, use `pi install git:git@github.com:debonzi/ai-tools.git`. For a reproducible install, append `@<tag-or-commit>` to the source; choose a ref that contains this layout. The historical `v0.1.0` tag is not a release of this layout.

`pi update git:github.com/debonzi/ai-tools` updates an unpinned installation from its branch; a tag or commit pin stays on that ref.

### From a local clone

Run these commands from the directory where you want to keep the checkout:

```sh
git clone https://github.com/debonzi/ai-tools.git
cd ai-tools
pi install "$(pwd)"
```

For SSH, use `git clone git@github.com:debonzi/ai-tools.git` instead. If you already have a clone, just run the last command from its root. To use a specific version, run `git checkout --detach <tag-or-commit>` in the clone before installing.

Pi loads the extensions directly from this directory. Keep the checkout in place and update it with Git, not `pi update`. If you already installed the GitHub source through Pi, remove that entry first to avoid loading the extensions twice.

### Scope and removal

Installation is personal by default. Add `-l` for project settings, which Pi reads after the project is trusted. Run `/reload` or restart Pi after changing the installation.

Use `pi list` to inspect installed sources. To uninstall, use `pi remove <source>` with the source from `pi list` and the same scope (`-l` for a project install).

## Choose which extensions load

Pi loads all three by default. Use `pi config` to enable or disable individual extensions after installing. For a reusable selection, use the object form of the `packages` entry in Pi settings. For example, to load just Context Meter:

```json
{
  "source": "git:github.com/debonzi/ai-tools",
  "extensions": ["extensions/context-meter/index.ts"]
}
```

The selection affects loading, not the Git checkout; all three extensions are downloaded and updated together.

## Migrate from older installations

1. Run `pi list` and `pi config` to identify old sources and filters. Check project settings as well if you used `-l`.
2. Remove old entries for the former aggregate package (`npm:@debonzi/dbz-ai-tools`), the individual `npm:@debonzi/pi-*` packages from this repository, and any local sources pointing at the old `packages/` layout or a local checkout registered with obsolete filters. Remove old direct extension paths and filters that reference moved or removed files. Use the exact installed source and scope when running `pi remove`.
3. Install the Git package and reapply your extension selection using `pi config`. Do not load an old copy or a separate development checkout alongside it. Provider and usage-widget settings stored outside the clone keep their existing paths.

## Develop and test

Use the [local clone installation](#from-a-local-clone) for development. To try a single extension for one session, run `pi -e ./extensions/codex-usage/index.ts` from the repository root without another copy of that extension already enabled.

Validation requires Git, Bash, GNU coreutils, Python 3, Node 24, and an installed Pi host. Set `PI_NODE_MODULES` to the directory containing the host's `@earendil-works/pi-coding-agent` package and its dependencies. For a global npm installation of Pi:

```sh
make check PI_NODE_MODULES="$(npm root --global)"
```

For Pi installed by the Pi installer, point `PI_NODE_MODULES` to the `node_modules` directory under the selected `~/.pi/agent/install/releases/<version>/`. If needed, set `PI_BIN` to the corresponding Pi executable. `make test-install` uses only the Pi executable and verifies the Git install and filtering with a local Git fixture and an isolated Pi profile. It does not contact GitHub or require provider credentials.

See the [changelog](CHANGELOG.md) and the [Git release procedure](docs/releasing.md).

## License

[MIT](LICENSE). See the [Copilot extension notices](extensions/copilot-usage/NOTICES.md) for third-party attribution.
