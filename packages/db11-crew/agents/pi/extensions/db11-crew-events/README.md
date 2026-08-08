# DB11 Crew Events

A minimal Pi adapter for DB11 Crew completion delivery. The CLI bundled with the `db11-crew` skill writes a private event addressed to the original Pi session; this extension recovers pending events and injects them with `deliverAs: "followUp"` and `triggerTurn: true`.

The extension is an intentionally required part of `@debonzi/db11-crew`, not a standalone distribution. It shares the skill's private state, event schema, validation rules, and lifecycle. It is inert outside an interactive Herdr-managed Pi process and does not dispatch workers, manage Git, install Herdr integration, or replace the DB11 Crew skill.

## State and delivery

Events and readiness markers always use `~/.local/state/db11-crew`; `DB11_CREW_STATE_DIR` and `XDG_STATE_HOME` do not change this location. Events are accepted only for the current Pi session and may reference only regular, current-user result files inside DB11 Crew's private results directory.

The delivery guarantee is at least once across process interruption. Event IDs and session entries suppress duplicate delivery during normal operation and after completed acknowledgement.

## Test

From the `packages/db11-crew` workspace in a full repository source checkout:

```bash
TZ=UTC node --test agents/pi/extensions/db11-crew-events/index.test.ts
```

This deterministic test uses temporary local state and does not require live Herdr access.
