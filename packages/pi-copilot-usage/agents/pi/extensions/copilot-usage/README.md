# GitHub Copilot Usage

A small Pi extension that shows allowance information for the active `github-copilot` account.

## Behavior

When a GitHub Copilot model is active, the extension publishes a right-aligned, dim usage widget below the editor. It refreshes on session start, model changes, and the configured interval. Depending on the response shape, the widget reports:

- AI Credits for current usage-based billing;
- premium requests for the legacy billing shape;
- chat requests for Copilot Free;
- unlimited allowances; or
- additional usage beyond the included allowance.

Run `/usage-copilot` to force a fresh query and display a detailed, non-persistent TUI notification with the account label, plan, current model, allowance, reset time, and additional usage when available.

The `/usage-copilot` command and `copilot-usage` widget key are independent from other usage extensions, so they can remain loaded during comparison.

## Configuration

The managed package checkout is immutable configuration input and may be reset by `pi update`. Put optional overrides outside it:

- Global: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/copilot-usage.json`
- Project: `.pi/copilot-usage.json`, loaded only after the project is trusted

Project values override global values. Copy `config.example.json` to the desired external path or create the file directly, then run `/reload` after changing it.

```json
{
  "refreshIntervalMinutes": 5
}
```

`refreshIntervalMinutes` accepts an integer from 1 to 1440. Missing files use the five-minute default. Invalid values fall back to the default and produce a warning. Credential and token fields are not supported.

## Privacy and authentication

GitHub's quota endpoint requires the original GitHub OAuth token rather than the short-lived Copilot inference token. The extension therefore:

1. validates that the active model and resolved authentication use an official `api.*.githubcopilot.com` origin;
2. resolves the short-lived credential used by the active Pi model;
3. reads the stored `github-copilot` credential through Pi's public API;
4. requires an OAuth credential created through Pi's `/login` flow;
5. verifies that the stored short-lived token matches the active runtime account; and
6. sends only the original GitHub OAuth token to the fixed `api.github.com` usage endpoint.

API keys, account mismatches, GitHub Enterprise Server, and custom or proxy origins fail before the OAuth token is sent. Tokens, raw responses, cache entries, and account fingerprints are never persisted by the extension. The in-memory cache uses a process-random HMAC fingerprint and is cleared at shutdown.

Successful response bodies are limited to 64 KiB. Requests time out after 15 seconds and are cancelled when the model or session changes. Error response bodies are discarded rather than displayed.

## Limitations

- `GET https://api.github.com/copilot_internal/user` is undocumented and may change without notice.
- Only the active Pi account is queried; the extension does not enumerate or switch accounts.
- Immediate account-change events are not available from Pi. Authentication is resolved again on commands and scheduled refreshes.
- GitHub Enterprise Server and account integrations that do not match Pi's canonical stored OAuth credential are unsupported.
- Provider snapshots may be delayed.

## Test

From the `packages/pi-copilot-usage` workspace in a full repository source checkout:

```bash
TZ=UTC node --test agents/pi/extensions/copilot-usage/core.test.ts agents/pi/extensions/copilot-usage/index.test.ts
```
