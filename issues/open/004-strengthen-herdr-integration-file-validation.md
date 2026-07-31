---
created: 2026-07-31
status: open
title: "Strengthen Herdr Integration File Validation"
dependencies:
  - "003-reject-installer-destination-symlinks"
---

## Description

Make validation of `herdr-agent-state.ts` fail closed before invoking `herdr integration install pi`. The installer currently treats any existing destination containing the substring `HERDR_INTEGRATION_ID=pi` as Herdr-managed, without requiring a regular file, an exact managed header, or corroboration from Herdr's integration status.

After destination directories are protected from symlink redirection, require a regular non-symlink file and validate the expected official metadata precisely. Use Herdr's reported integration state where possible, remain compatible with supported `installed` and `current` status formats, and refuse to authorize replacement of ambiguous user files.
