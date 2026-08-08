---
created: 2026-07-31
status: open
title: "Evaluate Lightweight Exploratory Subagents for DB11 Crew"
dependencies: []
---

## Description

Evaluate using spawned subagents for read-only exploratory tasks that do not require repository changes or isolated Git worktrees. Account for the existing `--read-only` and `--in-place` workflows, context-window reduction, tool and process isolation, mutation prevention, cancellation, output and cost limits, and criteria for allowing the principal session to choose bounded exploratory granularity. Produce a recommended workflow and implementation scope while preserving explicit user control for mutating work and preventing recursive delegation.
