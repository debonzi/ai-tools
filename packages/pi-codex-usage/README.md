# @debonzi/pi-codex-usage

A focused Pi extension that displays usage for the active official OpenAI Codex account. It adds one TUI widget and one command; it does not bundle skills or other DB11 resources.

## Requirements

The package declares `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer requirements. Pi provides these runtime packages when it loads the extension. Usage queries also require an active `openai-codex` model with authentication resolved by Pi against the official ChatGPT origin.

## Install

Install the published package:

```sh
pi install npm:@debonzi/pi-codex-usage
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/pi-codex-usage
```

Pi enables the declared extension by default. Use `pi config` for global resource control or `pi config -l` for project overrides. Run `/reload` or restart Pi after installation or configuration changes.

## Commands and widget

- `/usage-codex` forces a fresh query and shows a detailed, non-persistent TUI notification.
- The `codex-usage` widget appears below the editor while an OpenAI Codex model is active. It shows remaining quota, reset timing, and available or usable reset credits without replacing Pi's footer.

The former `/cusage` command is not registered. See the [package changelog](CHANGELOG.md) for the rename history.

## Configuration

Configuration is optional and must remain outside the managed package checkout:

- Global: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/codex-usage.json`
- Project: `.pi/codex-usage.json`, loaded only for a trusted project

Project values override global values. Copy the bundled [`config.example.json`](agents/pi/extensions/codex-usage/config.example.json) to one of those locations, or create a file containing only the desired non-secret settings:

```json
{
  "showOtherModels": false,
  "refreshIntervalMinutes": 5
}
```

The configuration accepts no credential or token field. See the [extension documentation](agents/pi/extensions/codex-usage/README.md) for behavior, valid ranges, privacy guarantees, and authentication details.

## Develop and test

From a full repository source checkout:

```sh
cd packages/pi-codex-usage
TZ=UTC node --test agents/pi/extensions/codex-usage/core.test.ts agents/pi/extensions/codex-usage/index.test.ts
npm pack --dry-run --ignore-scripts
```

The tests are repository-only and are excluded from the published tarball. Run `npm run check` and `npm run pack:check` from the repository root for complete workspace validation.

## License

MIT
