---
created: 2026-07-31
status: open
title: "Separate Shared DBZ Crew Documentation"
dependencies: []
---

## Description

Move cross-agent DBZ Crew behavior out of the Codex-only subsection in the root `README.md`. Worker inheritance, strict implementation preflight, and read-only workflow documentation apply to Pi and Codex, but their current placement makes them appear specific to Codex.

Create a clearly named shared DBZ Crew section at the appropriate documentation level, retain the link to `tools/dbz-crew/README.md`, and keep the Pi and Codex installation sections focused on their agent-specific behavior. Preserve English-only user-facing documentation and avoid duplicating the detailed command matrix.
