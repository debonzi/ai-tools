---
created: 2026-07-31
status: open
title: "Evaluate DBZ Crew Workflows from Feature Branches"
dependencies: []
---

## Description

Evaluate a safe DBZ Crew workflow when the principal session is working from a feature branch instead of `main`, which the current implementation preflight requires for mutating workers and lifecycle commands. Define expected dispatch bases, target-branch tracking, rebase, integration, cleanup, dirty-worktree handling, backward-compatible defaults, and required tests and documentation. Finish with a recommended design and bounded implementation scope without weakening the existing clean-`main` workflow.
