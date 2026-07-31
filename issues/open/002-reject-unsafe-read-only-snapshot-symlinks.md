---
created: 2026-07-31
status: open
title: "Reject Unsafe Symlinks in Read-Only Snapshots"
dependencies:
  - "001-secure-dbz-crew-state-root"
---

## Description

Prevent isolated read-only snapshots from exposing or modifying paths outside their assigned worktree. Tracked or non-ignored untracked symlinks can currently be reproduced verbatim, including absolute targets or relative targets that escape the repository. The snapshot manifest records the symlink text rather than the external target, so writes through an escaping link may not be detected by read-only validation.

After state-root handling is secured, validate symlinks before dispatch and reject snapshots containing absolute links or links whose resolved lexical target escapes the isolated worktree. Preserve safe repository-internal symlinks and the existing behavior of copying non-ignored untracked files. Do not add a filename-based credential denylist, because it would be incomplete and create false confidence.
