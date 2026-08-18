# @debonzi/pi-copilot-usage

A focused Pi extension that displays usage for the active official GitHub Copilot account. It adds one TUI widget and one command; it does not bundle skills or other DB11 resources.

## Requirements

The extension requires Pi 0.83.0 or newer and declares `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer requirements. Pi provides these runtime packages when it loads the extension.

Usage queries require an active `github-copilot` model authenticated through Pi's `/login` flow for a public `github.com` account. API-key credentials, a different active runtime account, GitHub Enterprise Server, and custom or proxy provider origins are rejected.

## Install

Install the published package:

```sh
pi install npm:@debonzi/pi-copilot-usage
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/pi-copilot-usage
```

Pi enables the declared extension by default. Use `pi config` for global resource control or `pi config -l` for project overrides. Run `/reload` or restart Pi after installation or configuration changes.

## Command and widget

- `/usage-copilot` forces a fresh query and shows a detailed, non-persistent TUI notification.
- The `copilot-usage` widget appears below the editor while a GitHub Copilot model is active. Depending on the account response, it shows AI Credits, premium requests, or Copilot Free chat requests, including additional usage beyond the included allowance.

## Configuration

Configuration is optional and must remain outside the managed package checkout:

- Global: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/copilot-usage.json`
- Project: `.pi/copilot-usage.json`, loaded only for a trusted project

Project values override global values. Copy the bundled [`config.example.json`](agents/pi/extensions/copilot-usage/config.example.json) to one of those locations, or create a file containing only the desired non-secret settings:

```json
{
  "refreshIntervalMinutes": 5
}
```

The configuration accepts no credential or token field. See the [extension documentation](agents/pi/extensions/copilot-usage/README.md) for behavior, valid ranges, privacy guarantees, authentication details, and limitations.

## Endpoint stability

The extension queries GitHub's undocumented `GET https://api.github.com/copilot_internal/user` endpoint. GitHub may change or remove this response without notice. Provider failures are reported without including response bodies or credentials.

## Develop and test

From a full repository source checkout:

```sh
cd packages/pi-copilot-usage
TZ=UTC node --test agents/pi/extensions/copilot-usage/core.test.ts agents/pi/extensions/copilot-usage/index.test.ts
npm pack --dry-run --ignore-scripts
```

The tests are repository-only and are excluded from the published tarball. Run `npm run check` and `npm run pack:check` from the repository root for complete workspace validation.

## License

MIT. See [`NOTICES.md`](NOTICES.md) for third-party attribution.
