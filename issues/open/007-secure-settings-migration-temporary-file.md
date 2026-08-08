---
created: 2026-07-31
status: open
title: "Secure Settings Migration Temporary File"
dependencies:
  - "003-reject-installer-destination-symlinks"
---

## Description

Replace the predictable legacy `settings.json.dbz-crew-migration.$$` path used by the former DBZ Crew installer while converting a Pi settings symlink. The old copy step can overwrite a stale file or follow a pre-existing destination symlink before permissions are tightened.

After installer destination directories are validated, the DB11 Crew successor must create the migration file exclusively with a randomized, DB11-named same-directory path and private permissions, clean it reliably on every failure path, and atomically replace only the previously validated legacy symlink. Preserve the original settings content and mode semantics without exposing a window for unexpected-file replacement.
