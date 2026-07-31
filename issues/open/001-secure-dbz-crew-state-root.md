---
created: 2026-07-31
status: open
title: "Secure DBZ Crew State Root Handling"
dependencies: []
---

## Description

Harden state-directory handling in the DBZ Crew CLI and Pi event extension. `DBZ_CREW_STATE_DIR` currently accepts arbitrary locations, existing directories may be chmodded unconditionally, and predictable child paths can follow symlinks during lock or result writes. A configured state directory can also be placed inside a Git worktree, making generated prompts, results, events, snapshots, and session markers eligible for accidental commits.

Introduce a shared state-root policy that rejects dangerous, repository-local, or symlinked destinations; safely supports the existing default state directory; verifies ownership and permissions where appropriate; and prevents state-file operations from following symlinks. Writes and directory creation should fail closed without altering unexpected paths. Keep the Python implementation and `agents/pi/extensions/dbz-crew-events/index.ts` behavior consistent.
