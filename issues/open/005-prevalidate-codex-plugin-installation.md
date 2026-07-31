---
created: 2026-07-31
status: open
title: "Prevalidate Codex Plugin Installation"
dependencies: []
---

## Description

Refactor the Codex installation flow so marketplace and plugin state are fully inspected before the first external mutation. The current workflow may add the `dbz-ai-tools` marketplace before discovering that an existing `dbz-crew@dbz-ai-tools` plugin points to an unexpected or unparseable source, leaving partial global configuration after failure.

Collect and validate both marketplace and installed-plugin metadata first, fail closed when an existing plugin has no trustworthy source path, and only then perform the minimum required add or refresh operations. Where a later external command can still fail, report partial state clearly and use safe rollback only when the Codex CLI provides a verified operation for it.
