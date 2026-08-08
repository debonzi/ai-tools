# DB11 rename and history policy

This document is the canonical naming and history policy for the DBZ-to-DB11 rebrand. It applies to tracked repository source, package contents, release tooling, tests, and current documentation. Git history, local Wyrd state, ignored drafts, dependency trees, generated caches, and remote GitHub or npm state are outside the source rewrite.

## Classification rules

Every DBZ reference encountered during the rebrand must receive one of these classifications:

- **Replace**: the reference identifies current code, branding, metadata, a resource, a path, a protocol, a test expectation, or current usage instructions. Use the canonical DB11 identity.
- **Preserve**: the reference is an immutable historical fact, such as released changelog text, a closed issue, an old tag, or the old side of a negative compatibility test. Do not rewrite the fact.
- **Annotate**: the old identity is necessary to explain migration, removal, deprecation, or an unresolved legacy behavior. Retain the old identity, name its DB11 successor when one exists, and make it unambiguous that the old identity is not current.

Unclassified DBZ references are not allowed in the final tracked source. An old name is not historical merely because it already exists; current examples, links, fixtures, and prose are active unless they explicitly describe old behavior.

## Canonical identity map

### Repository and workspace

| Current DBZ identity | Canonical DB11 identity | Policy |
| --- | --- | --- |
| DBZ AI Tools / DBZ Pi packages | DB11 AI Tools / DB11 Pi packages | Replace in current branding and prose. |
| `dbz-ai-tools` repository slug | `db11-ai-tools` | Replace in active metadata, Changesets configuration, links, and external-cutover instructions. |
| `dbz-ai-tools-workspace` | `db11-ai-tools-workspace` | Replace in the private root manifest, lockfile, and tests. |
| `github.com/debonzi/dbz-ai-tools` current-source URLs | `github.com/debonzi/db11-ai-tools` | Replace active URLs. Retain old URLs only in clearly labeled removal or migration instructions. |
| `@debonzi/dbz-ai-tools` former aggregate npm package | No DB11 aggregate package | Preserve or annotate as a retired package. The private root must not become `@debonzi/db11-ai-tools` and must never be published. |
| `dbz-ai-tools-setup` / `skill:dbz-ai-tools-setup` | No replacement | Preserve only in historical text and assertions that the retired resource is absent. Do not create a DB11 alias. |

A local checkout directory does not define a product identity and need not be renamed by repository code. Existing Git commits, Conventional Commit scopes, branches not created by the current runtime, and tags are historical records and are never rewritten solely for branding.

### Skills package

| Current DBZ identity | Canonical DB11 identity |
| --- | --- |
| `@debonzi/dbz-skills` | `@debonzi/db11-skills` |
| `packages/dbz-skills` / selector `dbz-skills` | `packages/db11-skills` / selector `db11-skills` |
| `dbz-skills-vX.Y.Z` | `db11-skills-vX.Y.Z` |
| `dbz-issues` / `/skill:dbz-issues` | `db11-issues` / `/skill:db11-issues` |
| `dbz-spec` / `/skill:dbz-spec` | `db11-spec` / `/skill:db11-spec` |
| DBZ Issues / DBZ Spec | DB11 Issues / DB11 Spec |
| `.NNN.dbz-issues-reservation` | `.NNN.db11-issues-reservation` |
| Internal `dbz_issues*`, `DbzIssues*`, and `dbz-issues-test-*` identifiers | Equivalent `db11_issues*`, `Db11Issues*`, and `db11-issues-test-*` identifiers |

Package paths, manifests, skill frontmatter, bundled file allowlists, agent metadata, tests, and current examples use the DB11 side. The old package and skill names may remain only in migration guidance, historical changelog entries, and explicit rejection or absence tests.

### Crew package and runtime

| Current DBZ identity | Canonical DB11 identity |
| --- | --- |
| DBZ Crew / `DBZ-CREW` | DB11 Crew / `DB11-CREW` |
| `@debonzi/dbz-crew` | `@debonzi/db11-crew` |
| `packages/dbz-crew` / selector `dbz-crew` | `packages/db11-crew` / selector `db11-crew` |
| `dbz-crew-vX.Y.Z` | `db11-crew-vX.Y.Z` |
| `dbz-crew` skill and CLI | `db11-crew` skill and CLI |
| `dbz-crew-setup` | `db11-crew-setup` |
| `dbz-crew-events` | `db11-crew-events` |
| `~/.local/state/dbz-crew` | `~/.local/state/db11-crew` |
| `DBZ_CREW_EVENT_POLL_MS` | `DB11_CREW_EVENT_POLL_MS` |
| `DBZ_CREW_STATE_DIR` | No supported DB11 state-root override by default; the fixed DB11 state path remains authoritative unless the runtime migration contract explicitly decides otherwise. |
| `dbz-crew-event` | `db11-crew-event` |
| `dbz-crew-event-delivered` | `db11-crew-event-delivered` |
| `DBZ-CREW RESULT:` and other protocol sentinels | Equivalent `DB11-CREW ...` sentinels |
| `dbz-crew/<suffix>/<task>` worker branches | `db11-crew/<suffix>/<task>` worker branches |
| Internal `dbz_crew*`, `dbzCrew*`, and DBZ-named fixtures | Equivalent `db11_crew*`, `db11Crew*`, and DB11-named fixtures |
| `SMOKE_DBZ_CREW.md` / `test_dbz_crew.py` | `SMOKE_DB11_CREW.md` / `test_db11_crew.py` |

These rows define the target namespace, not a license to replace persistent or interoperable identifiers blindly. The approved DB11 Crew runtime contract is the hard, isolated cutover described under [Crew package](#crew-package): legacy state and protocol identities receive no compatibility bridge and remain untouched for rollback.

### Other active repository identifiers

| Current DBZ identity | Canonical DB11 identity | Policy |
| --- | --- | --- |
| `dbz-codex-usage` HTTP User-Agent | `db11-codex-usage` | Replace; it is active branding, not a compatibility API. |
| References to “other DBZ resources” in `pi-codex-usage` | “other DB11 resources” | Replace. The `@debonzi/pi-codex-usage` package name itself does not change. |
| DBZ-named active issue titles and filenames | Equivalent DB11 names | Replace when the issue concerns current DB11 behavior. Preserve links to closed DBZ-named issue IDs. |

## Tracked source inventory

The initial tracked-source inventory found active DBZ identities in these areas. The implementing tasks own the corresponding replacements:

| Area | Tracked locations | Required treatment |
| --- | --- | --- |
| Root identity and catalog | `package.json`, `package-lock.json`, `README.md` | Replace current workspace, package, path, and brand references; annotate retired aggregate-package migration examples. |
| Release system | `.changeset/`, `.github/workflows/release.yml`, `Makefile`, `docs/releasing.md`, `scripts/release_identity.py`, `tests/test_release.py` | Replace accepted selectors, paths, npm identities, tag families, repository slug, and current fixtures. Preserve old identities only as explicit rejection or migration cases. |
| Package validation | `tests/test_package.py`, `tests/test-package-install.sh` | Replace current manifests, resources, paths, install expectations, and test environment names. Preserve assertions about removed legacy resources where they remain useful. |
| Skills package | `packages/dbz-skills/**` | Rename the workspace, package, skills, metadata, internal identifiers, tests, and current documentation. Apply the changelog policy below. |
| Crew package | `packages/dbz-crew/**` | Rename the workspace, package, resources, code, protocol namespace, tests, and current documentation only after applying the runtime migration contract. Apply the changelog policy below. |
| Codex Usage package | `packages/pi-codex-usage/package.json`, `packages/pi-codex-usage/README.md`, `packages/pi-codex-usage/agents/pi/extensions/codex-usage/index.ts` | Replace repository URLs, DBZ prose, and the active User-Agent while retaining the package identity. |
| Active issues | `issues/open/011-*dbz-crew.md`, `issues/open/012-*dbz-crew*.md` | Rename files, titles, and current product references to DB11 Crew. |
| Legacy-sensitive active issues | `issues/open/002-*.md`, `issues/open/007-*.md` | Preserve the closed-issue dependency ID in issue 002. Annotate the exact legacy temporary filename in issue 007 rather than pretending it is a current DB11 path; any successor implementation must use DB11 naming and a safe randomized file. |
| Historical records | `CHANGELOG.md`, package `CHANGELOG.md` files, `issues/closed/**` | Follow the history policy below; do not perform a bulk replacement. |

The root lockfile is generated inventory: update it through npm after workspace manifests and paths change rather than editing old identities selectively.

## History and migration policy

### Git and release history — Preserve

Do not rewrite existing commits, tags, released versions, or old Conventional Commit subjects. Existing DBZ package-qualified tags remain attached to their original objects. New releases use DB11 tag families; old tag families are not accepted as aliases for new releases.

### Closed issues — Preserve

Files under `issues/closed/` preserve their filenames, frontmatter, titles, bodies, and exact implementation identifiers. They describe the source as it existed when the issue was resolved. Active dependencies that refer to a closed issue keep its DBZ-named ID so the reference remains valid. If modern context is needed, add it to current documentation or an active issue instead of rewriting the closed record.

### Changelogs — Preserve released entries; annotate their container

Released DBZ changelog entries remain verbatim. Do not make an old release claim that it shipped DB11 names.

- The root `CHANGELOG.md` remains the historical changelog of the former `@debonzi/dbz-ai-tools` aggregate package. Its heading and released entry are preserved. Its introductory annotation and relative navigation links may be updated to point readers to the DB11 successors.
- A renamed package changelog uses the current DB11 package identity in its heading and receives a new release entry describing the rename. Existing DBZ release sections and their text remain unchanged.
- Broken relative links caused by workspace directory renames are structural navigation, not historical facts; update their destinations while preserving historical link labels where the old name is the fact being described.

### Legacy examples and migration references — Annotate

Retain an old command or identifier only when a reader must use or recognize that exact old identity to migrate, remove, deprecate, reject, or diagnose it. Such text must show an explicit old-to-new mapping and label the old side as former, legacy, deprecated, or unsupported.

Current install, invocation, release, and development examples always use DB11. In particular:

- there is no aggregate `@debonzi/db11-ai-tools` package;
- consumers remove the old package source and install the selected DB11 packages explicitly;
- Pi package filters and enabled resources do not migrate automatically;
- the renamed skills have no temporary DBZ aliases;
- users review configuration and reload or restart Pi after changing installed packages;
- publishing new npm identities, deprecating old npm identities, renaming GitHub, and relying on redirects require a separately authorized external cutover.

Tests may preserve DBZ strings when they prove that old selectors are rejected, removed resources stay absent, migration input is recognized, or historical examples remain intentional. Test names and fixtures for current successful behavior use DB11.

## Compatibility expectations

### Repository and release tooling

The source tree performs a hard cutover to DB11 workspace paths, package selectors, and release tag families. Release tooling must not silently accept DBZ selectors or create new DBZ tags. Existing tags and published artifacts remain historical. Active metadata uses canonical DB11 repository URLs rather than depending on a hosting redirect.

### Skills package

The DB11 npm package and skill names are new Pi resource identities. No compatibility aliases are bundled because aliases would keep active DBZ resources installed and could collide with old packages. Migration is explicit: inspect the old installation, remove its reported source, install `@debonzi/db11-skills`, review package filters, and reload or restart Pi. The transient issue-reservation filename has no persistent compatibility guarantee.

### Crew package

The approved runtime contract is an immediate hard namespace cutover with no compatibility window, automatic state migration, or protocol bridge. Consumers finish or clean up former DBZ workers before removing the old package, install the DB11 package, update resource filters, and reload Pi. The DB11 runtime uses only `~/.local/state/db11-crew`, DB11 environment and protocol identities, and DB11 worker branches. Former state-root overrides, events, delivered markers, result sentinels, branches, and installed resources are unsupported by the new runtime.

Legacy `~/.local/state/dbz-crew` is never read, merged, moved, chmodded, followed, overwritten, or deleted. Clean DB11 state is created with the existing ownership, permission, normalization, anti-symlink, and worktree-isolation guarantees. When old and new trees both exist, only the DB11 tree is used and an unsafe DB11 path fails closed independently. Repeating startup is idempotent because the old tree remains out of scope. Rollback requires stopping DB11 workers, switching package sources and filters back, and reloading Pi; the former runtime then sees its untouched state. The package [migration procedure](../packages/db11-crew/README.md#migrate-from-the-former-dbz-runtime) is normative consumer guidance.

## Temporarily inconsistent commits

Prefer cohesive commits that leave manifests, paths, tests, and documentation consistent. If parallel implementation requires a commit that intentionally leaves the repository temporarily inconsistent:

1. Use a valid Conventional Commit subject containing the standalone lowercase token `wip`, for example `refactor(workspace): wip rename package paths`.
2. In the commit body, list the exact inconsistency, affected DBZ and DB11 identities, expected failing checks, and the task or follow-up commit that will restore consistency.
3. Do not publish, tag, push an external cutover, or complete final integration from such a commit.
4. Remove the inconsistency in a later non-`wip` commit; do not rewrite shared history merely to hide the intermediate commit.

A commit is not `wip` merely because the overall rebrand is unfinished. The marker is required only when that commit intentionally breaks an invariant that the repository normally enforces.

## Final residual-name audit

The final integration must inspect both tracked paths and tracked text:

```sh
git ls-files | grep -i 'dbz' || true
git grep -In -i 'dbz' || true
```

Every remaining match must be attributable to one of these bounded categories:

- this policy's old-to-new inventory;
- preserved closed issues and their active dependency IDs;
- preserved released changelog text;
- explicitly labeled consumer migration or external-cutover guidance;
- explicit tests for rejection, absence, or supported legacy transition behavior.

The final audit classifies the tracked matches as follows:

- the only DBZ-named paths are preserved closed issues 001 and 008;
- `issues/closed/**`, the root historical changelog, and the historical sections of package changelogs are preserved records;
- the root and package READMEs plus `docs/releasing.md` contain labeled migration, removal, or legacy-rejection guidance;
- active issues 002 and 007 contain, respectively, a preserved closed-issue dependency and an explicitly labeled legacy temporary filename;
- `tests/test_package.py`, `tests/test_release.py`, `tests/test-package-install.sh`, and DB11 Crew runtime tests contain only absence, rejection, environment-isolation, or untouched-legacy-state assertions;
- this policy contains the complete old-to-new inventory and this classification.

No remaining match may act as a current package name, workspace path, release selector, tag family, repository URL, skill or extension name, CLI name, runtime protocol identifier, branch prefix, User-Agent, or unannotated current branding.
