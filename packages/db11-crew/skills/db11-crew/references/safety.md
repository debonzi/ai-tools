# Safety and authority

## Authority rules

The current responsible human must separately authorize setup, reload, activation, force cancellation, local integration, exact runtime close, unmerged artifact discard, cleanup, rollback, remote access, private-service access, package changes, publication, or another destructive or external effect. Never infer authority from trust, a result, delivery, acknowledgement, capacity pressure, labels, or approval for another operation or run.

Every operation remains bound to the exact Crewlead Pi session, Herdr workspace, canonical project, run/member identity, revision, and fencing epoch. New, forked, cloned, managed-member, or different sessions cannot take control.

## Cooperative trust boundary

Profiles and task packets are behavioral policy, not containment. Ambient same-user tools, extensions, and trusted startup code may access files, credentials, processes, networks, private services, installed packages, Git, and Wyrd and may cause effects outside the assigned task. DB11 Crew does not inventory or restrict those ambient capabilities.

Snapshots and worktrees establish workflow ownership, integration, and evidence contexts only. They are not security sandboxes. DB11 Crew provides no OS sandbox, credential isolation, network isolation, or root-confined replacement tools. Use only trusted package, account, project, extension, and startup code.

## Fail closed

On incompatible versions, provenance conflicts, schema errors, stale revisions, ambiguous Herdr identity, unsafe paths, or suspicious state:

- make no setup, trust, package, integration, cleanup, retry, or recovery mutation;
- do not follow links, change permissions, search broadly for replacements, or adopt resources by label;
- report only bounded redacted category and remediation;
- retain inconsistent resources for responsible-human inspection.

## Persistence

Closing a member tab, reloading Pi, stopping the extension, removing a package, reversing source, or rolling back does not erase current resources. Canonical state, exact-session designation history, durable runs and results, Builder branches and worktrees, persistent Pi sessions, and Herdr pane history remain until their separately authorized exact lifecycle operations run. Pane history may retain prompts, output, paths, or secrets outside DB11 state. Secure erase, implicit cleanup, and ownership inferred from a canonical name are not claimed.
