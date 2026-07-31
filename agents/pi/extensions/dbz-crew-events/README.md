# DBZ Crew Events

A minimal Pi adapter for DBZ Crew completion delivery. The shared CLI writes a private event addressed to the original Pi session; this extension recovers pending events and injects them with `deliverAs: "followUp"` and `triggerTurn: true`.

The extension is inert outside an interactive Herdr-managed Pi process. It does not dispatch workers, manage Git, or replace the shared DBZ Crew skill.

## State

Events and readiness markers use `${DBZ_CREW_STATE_DIR}` or `${XDG_STATE_HOME:-~/.local/state}/dbz-crew`. Events are validated against the current Pi session and may reference results only inside DBZ Crew's private results directory.

The delivery guarantee is at least once across process interruption. Event IDs and session entries suppress duplicate delivery during normal operation and after completed acknowledgement.

## Test

```bash
TZ=UTC node --test agents/pi/extensions/dbz-crew-events/index.test.ts
```
