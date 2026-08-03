# Codex Usage

A small Pi extension that shows usage for the active `openai-codex` account. It
uses Pi's resolved runtime authentication and queries the official ChatGPT usage
endpoint directly.

## Behavior

When an OpenAI Codex model is active, the extension publishes a right-aligned,
dim `cusage` widget below the editor containing the remaining quota, reset time,
and available/usable reset credits. The widget occupies its own layout row and
does not replace or overlap Pi's footer. It refreshes on session start, model
changes, and the configured interval.

Run `/cusage` to force a fresh query and display a detailed, non-persistent TUI
notification. The report includes every returned limit group, even when the
footer is configured to show only the selected model.

The temporary command and widget key intentionally differ from `pi-usage`, so
both extensions can remain loaded during comparison.

## Configuration

The managed package checkout is immutable configuration input and may be reset by `pi update`. Put optional overrides outside it:

- Global: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/codex-usage.json`
- Project: `.pi/codex-usage.json`, loaded only after the project is trusted

Project values override global values. Copy `config.example.json` to the desired external path or create the file directly, then run `/reload` after changing it.

```json
{
  "showOtherModels": false,
  "refreshIntervalMinutes": 5
}
```

- `showOtherModels`: include non-selected model limits in the widget. The
  `/cusage` report always includes them.
- `refreshIntervalMinutes`: automatic refresh interval from 1 to 1440 minutes.

Missing files use defaults. Invalid values fall back to defaults and produce a warning.

## Privacy and authentication

- Only the active Pi `openai-codex` runtime credential is used.
- Credentials associated with custom or proxy origins are rejected.
- Tokens, raw responses, and cache entries are never persisted.
- The account label is derived from the local part of the returned email. The
  complete email and opaque account identifiers are not displayed.
- The Codex CLI is not used as an authentication fallback.

## Test

From the repository root:

```bash
TZ=UTC node --test agents/pi/extensions/codex-usage/core.test.ts
```
