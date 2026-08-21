# Releasing the DB11 Pi packages

This document defines the independent release contract for the three publishable workspaces. The repository root is a private coordinator and is never versioned, tagged as a package, or published.

## Release identities

Release code must use this fixed allowlist rather than deriving a path or npm identity from arbitrary input:

| `PACKAGE` selector | Workspace | npm package | Annotated tag |
| --- | --- | --- | --- |
| `db11-skills` | `packages/db11-skills` | `@debonzi/db11-skills` | `db11-skills-vX.Y.Z` |
| `pi-codex-usage` | `packages/pi-codex-usage` | `@debonzi/pi-codex-usage` | `pi-codex-usage-vX.Y.Z` |
| `pi-copilot-usage` | `packages/pi-copilot-usage` | `@debonzi/pi-copilot-usage` | `pi-copilot-usage-vX.Y.Z` |

Legacy `dbz-skills` and `dbz-crew` selectors are historical only and are rejected for new releases; existing legacy tags remain unchanged.

Versions and releases are independent. Equal version numbers do not create a fixed or linked release group, and one release metadata commit may be the target of more than one package-qualified tag.

## Changesets

Changesets remain in the repository root. [`.changeset/config.json`](../.changeset/config.json) intentionally has empty `fixed` and `linked` groups.

Add a Changeset for every user-visible package change:

```sh
npx changeset
```

Select every affected npm package explicitly, choose its SemVer impact, and write a concise consumer-facing summary. Never target the private root. A single Changeset may name multiple affected packages without linking their future versions.

`npx changeset version` may update every workspace with pending changes in one release metadata commit. It must update only affected workspace manifests and changelogs plus the root lockfile and consumed Changesets. Each resulting package version is still tagged, approved, and published independently.

## Release contract

For each selected package:

- the tag is package-qualified, annotated, and uses the mapping above;
- the tag version exactly matches the selected workspace manifest;
- the expected npm identity exactly matches that workspace manifest;
- the tag commit is reachable from `main`;
- the private root and other workspaces cannot be selected for publication;
- `npm ci`, `npm run check`, and `npm run pack:check` pass before tag creation and again before publication;
- GitHub environment approval occurs only after validation;
- the workflow publishes exactly the selected workspace with public access and provenance;
- normal publication uses npm trusted publishing through GitHub Actions OIDC;
- local release targets never run `npm publish`.

The workflow must reject lightweight tags, malformed versions, unknown selectors, name/version mismatches, and tags outside `main`. It must map the validated selector through fixed code to one workspace; it must not treat tag text as an arbitrary directory.

## Local release interface

Use the staged flow below. `release-prepare` requires at least one pending Changeset. The initial `0.1.0` publication of a package whose metadata is already committed starts at the package-specific `release-preflight` step instead.

```sh
# Apply all pending Changesets, synchronize the lockfile, inspect the result,
# and commit only generated release metadata.
make release-prepare
make release-commit

# Select one updated package and its exact manifest version.
make release-info PACKAGE=db11-skills VERSION=X.Y.Z
make release-preflight PACKAGE=db11-skills VERSION=X.Y.Z
make release-check PACKAGE=db11-skills VERSION=X.Y.Z
make release-tag PACKAGE=db11-skills VERSION=X.Y.Z
make release-push PACKAGE=db11-skills VERSION=X.Y.Z
```

`release-info` is a local, non-mutating identity and manifest check. The package selector is required for every package-specific validation, tag, and push target. `release-tag` creates `db11-skills-vX.Y.Z` in this example, and `release-push` atomically pushes `main` and that tag. Repeat the package-specific steps for another workspace updated by the same Changesets release commit.

`release-prepare` and every package-specific tag or push flow must start from a clean local `main`, verify that it includes current remote `main`, and reject existing local or remote tags where applicable. `release-commit` intentionally runs after preparation has changed release metadata; it rejects pre-staged or unrelated changes and accepts only consumed Changesets, affected workspace `package.json` and `CHANGELOG.md` files, and the root `package-lock.json`.

Do not use local `npm publish` as a fallback. If the selector mapping, archive validation, protected environment, trusted publishing, or provenance cannot be guaranteed, stop the release.

## GitHub publication

The release workflow must trigger only for these tag families:

```text
db11-skills-v*
pi-codex-usage-v*
pi-copilot-usage-v*
```

Validation must parse the tag, apply the fixed mapping, verify the selected workspace name and version, check `main` ancestry, install locked dependencies, and validate all workspace archives. The publish job may receive only the validated fixed workspace and npm identity. It publishes from that workspace after approval in the protected `npm` environment, using `--access public --provenance`.

The publish job alone needs `id-token: write`; repository contents remain read-only. Publication concurrency is keyed by the complete tag and must not cancel an in-progress publish.

## External trusted-publisher bootstrap

Each npm identity requires its own registry entry and trusted-publisher authorization:

- `@debonzi/db11-skills`
- `@debonzi/pi-codex-usage`
- `@debonzi/pi-copilot-usage`

For each package, the trusted publisher must authorize this GitHub Actions identity:

| Setting | Value |
| --- | --- |
| GitHub organization or user | `debonzi` |
| Repository | `db11-ai-tools` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

An initial publication may require a short-lived, package-scoped bootstrap token because npm cannot configure a trusted publisher for a package that does not yet exist. Store such a token only as a protected environment secret, remove and revoke it immediately after bootstrap, configure the trusted publisher separately for each npm package, and then disallow traditional token publication.

Registry creation, trusted-publisher setup, GitHub environment configuration, secrets, approvals, and first publication are external operations. They are not performed by repository implementation or local validation.

## One-time external cutover

The repository rename, initial DB11 package publications, former-package deprecations, redirect verification, rollback gates, and consumer announcement use the separately authorized [DB11 external cutover runbook](db11-external-cutover.md). The runbook is a plan, not authorization: GitHub and npm inventory, mutation, publication, trusted-publisher, and deprecation operations each require approval for their exact remote targets.
