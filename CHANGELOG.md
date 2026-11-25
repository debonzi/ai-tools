# Changelog

## 0.2.0 - 2026-11-25

- Distribute AI Tools as one Git-installed Pi package, without a registry publish, build, or dependency install for users.
- Expose Codex Usage, Context Meter, and Copilot Usage through Pi's `extensions/` discovery. Select which extensions load with `pi config`.
- Retire the independent npm workspace release process and remove previously archived resources. See the [migration guide](README.md#migrate-from-older-installations) for existing installations.

## Previous layout (independent npm workspaces)

- Codex Usage introduced an independent workspace at `0.1.0` and renamed `/cusage` to `/usage-codex`.
- Context Meter introduced an independent workspace at `0.1.0` with the `pi-context-meter` tool.
- Copilot Usage introduced an independent workspace at `0.1.0` with `/usage-copilot` and the `copilot-usage` widget for the active Pi OAuth account.

## 0.1.0 (historical `@debonzi/dbz-ai-tools` aggregate)

- Published the initial DBZ AI Tools aggregate package for the Pi package gallery.
