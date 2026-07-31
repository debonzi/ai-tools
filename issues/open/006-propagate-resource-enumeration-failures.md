---
created: 2026-07-31
status: open
title: "Propagate Resource Enumeration Failures"
dependencies: []
---

## Description

Ensure installer resource discovery cannot fail silently. `resource_entries` currently relies on `find -printf` and `sort`, while callers consume it through process substitution that does not propagate producer failures. An unsupported `find`, missing command, or read error can therefore make validation appear successful and allow installation to continue with an incomplete resource set.

Use a checked and deterministic enumeration mechanism, validate every required prerequisite, and preserve failures through validation and installation callers. The implementation should handle hidden resource names, exclude only the intentional `.gitkeep` placeholder, avoid unsafe filename parsing, and make no destination changes after an enumeration error.
