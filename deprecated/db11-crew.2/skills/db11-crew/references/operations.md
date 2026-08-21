# Structured run operations

## Observe and inspect

Use `db11_crew_list` for a bounded overview. Use `db11_crew_inspect` for one exact run and request packet/result details only when needed. Treat Herdr `idle`, `done`, missing resources, or terminal text as observations, never completion.

## Same-task interaction

Use `db11_crew_amend` only for a correction, clarification, additional input, narrowing, or reviewed recovery that remains the same delegated task. A material objective, permission, boundary, or independently completable scope change requires a new run.

Use `db11_crew_respond_blocker` with the exact run revision, blocker ID, and blocker revision. A response does not clear the blocker; the member must clear it after applying the decision. Direct human interaction in the member tab remains valid and is recorded as an ordered amendment.

## Results

Use `db11_crew_result` to retrieve the full immutable result or the narrow structured section needed. Acknowledge only after responsible review. Delivery and acknowledgement do not authorize integration, retry, cleanup, cancellation, or acceptance.

## Cancellation and recovery

Graceful cancellation is an explicit revision-raced request. It may remain nonterminal until the companion settles and commits a checkpoint. Force cancellation requires a prior graceful request plus separate responsible-human confirmation for the exact member. Never escalate automatically.

Use recovery only after exact-session reconciliation. Continue the same run only when a responsible human classifies side effects as absent or reviewed and bounded. Unknown effects retain the run for investigation; retry is a separately authorized new run.

## Runtime and repository disposition

Runtime cleanup concerns only the exact terminal Herdr runtime. Assess first. Pins and inspection leases retain it. Close or record an external close only with explicit exact authority. Runtime cleanup never deletes Pi sessions, durable DB11 state/results, or Git resources.

Builder integration is separately responsible-human-authorized local fast-forward-only integration for one exact completed run. It never pushes, pulls, rebases, merges with a merge commit, resolves conflicts, or cleans afterward.

Repository cleanup is independent. It requires exact ownership and verified integration, supersession, read-snapshot disposition, or separately confirmed discard with acknowledged artifacts. Never run global prune, broad reset/stash/clean, or foreign branch/worktree deletion.
