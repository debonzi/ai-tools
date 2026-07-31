---
created: 2026-07-31
status: open
title: "Reject Installer Destination Symlinks"
dependencies: []
---

## Description

Strengthen installer destination validation so configured agent homes, skills directories, resource directories, and `~/.local/bin` cannot silently redirect installation through unexpected symlinks. The current `validate_parent_directory` check follows directory symlinks, while broken symlinks can evade ordinary existence tests and fail only after other installation changes have started.

Detect direct and broken symlinks explicitly before any mutation, distinguish supported legacy migrations from arbitrary destination redirection, and fail with a clear message while preserving all existing files. Add coverage for `CODEX_HOME`, `PI_CODING_AGENT_DIR`, resource directories, and the binary destination.
