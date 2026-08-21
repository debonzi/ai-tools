# DB11 Crew setup reference index

Load references progressively:

- [`diagnostics.md`](diagnostics.md): read-only probes, report interpretation, and fail-closed boundaries.
- [`settings.md`](settings.md): validated non-secret account settings and write confirmation.
- [`herdr-integration.md`](herdr-integration.md): exact read-only-first official Herdr Pi integration flow.
- [`activation-reload.md`](activation-reload.md): canonical diagnosis, explicit activation, exact-session restoration, failure states, and current-resource persistence.

Setup has no shell recipe fallback. Use the package's human-facing extension commands and stop when they cannot establish a safe plan.
