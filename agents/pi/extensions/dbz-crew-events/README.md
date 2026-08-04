# DBZ Crew Events

A minimal Pi adapter for DBZ Crew completion delivery. The CLI bundled with the `dbz-crew` skill writes a private event addressed to the original Pi session; this extension recovers pending events, emits each validated event on Pi's `dbz-crew:completion` event-bus channel for cohesive coordinator adapters, and injects it with `deliverAs: "followUp"` and `triggerTurn: true`.

The extension is inert outside an interactive Herdr-managed Pi process. Event-bus emission does not grant a worker canonical-write authority. The extension does not dispatch workers, manage Git, or replace the shared DBZ Crew skill.

## State

Events and readiness markers always use `~/.local/state/dbz-crew`; `DBZ_CREW_STATE_DIR` and `XDG_STATE_HOME` do not change this location. Events are validated against the current Pi session and may reference only regular, current-user result files inside DBZ Crew's private results directory.

The delivery guarantee is at least once across process interruption. Event IDs and session entries suppress duplicate delivery during normal operation and after completed acknowledgement.

## Test

```bash
TZ=UTC node --test agents/pi/extensions/dbz-crew-events/index.test.ts
```
