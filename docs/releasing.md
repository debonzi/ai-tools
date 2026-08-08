# Releasing the DBZ Pi packages

This document defines the independent release contract for the three publishable workspaces. The repository root is a private coordinator and is never versioned, tagged as a package, or published.

> **Implementation status:** Phase 3 must still update the current Makefile and GitHub release workflow to implement this contract. The command interface below is the required Phase 3 target, not an executable procedure in the current checkout. Do not create release tags or run the legacy release targets until that alignment is complete.

## Release identities

Release code must use this fixed allowlist rather than deriving a path or npm identity from arbitrary input:

| `PACKAGE` selector | Workspace | npm package | Annotated tag |
| --- | --- | --- | --- |
| `dbz-skills` | `packages/dbz-skills` | `@debonzi/dbz-skills` | `dbz-skills-vX.Y.Z` |
| `dbz-crew` | `packages/dbz-crew` | `@debonzi/dbz-crew` | `dbz-crew-vX.Y.Z` |
| `pi-codex-usage` | `packages/pi-codex-usage` | `@debonzi/pi-codex-usage` | `pi-codex-usage-vX.Y.Z` |

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

## Target local interface for Phase 3

Phase 3 must make the Makefile and this section identical. The intended staged flow is:

```sh
# Apply all pending Changesets, synchronize the lockfile, and inspect the result.
make release-prepare
make release-commit

# Select one updated package and its exact manifest version.
make release-preflight PACKAGE=dbz-crew VERSION=X.Y.Z
make release-check PACKAGE=dbz-crew VERSION=X.Y.Z
make release-tag PACKAGE=dbz-crew VERSION=X.Y.Z
make release-push PACKAGE=dbz-crew VERSION=X.Y.Z
```

The package selector is required for every package-specific validation, tag, and push target. `release-tag` creates `dbz-crew-vX.Y.Z` in this example, and `release-push` atomically pushes `main` and that tag. Repeat the package-specific steps for another workspace updated by the same Changesets release commit.

Before mutation, release tooling must require a clean local `main`, verify that it includes current remote `main`, and reject existing local or remote tags. `release-commit` must reject pre-staged or unrelated changes and accept only consumed Changesets, affected workspace `package.json` and `CHANGELOG.md` files, and the root `package-lock.json`.

Do not use local `npm publish` as a fallback. If the selector mapping, archive validation, protected environment, trusted publishing, or provenance cannot be guaranteed, stop the release.

## GitHub publication

The release workflow must trigger only for these tag families:

```text
dbz-skills-v*
dbz-crew-v*
pi-codex-usage-v*
```

Validation must parse the tag, apply the fixed mapping, verify the selected workspace name and version, check `main` ancestry, install locked dependencies, and validate all workspace archives. The publish job may receive only the validated fixed workspace and npm identity. It publishes from that workspace after approval in the protected `npm` environment, using `--access public --provenance`.

The publish job alone needs `id-token: write`; repository contents remain read-only. Publication concurrency is keyed by the complete tag and must not cancel an in-progress publish.

## External trusted-publisher bootstrap

Each npm identity requires its own registry entry and trusted-publisher authorization:

- `@debonzi/dbz-skills`
- `@debonzi/dbz-crew`
- `@debonzi/pi-codex-usage`

For each package, the trusted publisher must authorize this GitHub Actions identity:

| Setting | Value |
| --- | --- |
| GitHub organization or user | `debonzi` |
| Repository | `dbz-ai-tools` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

An initial publication may require a short-lived, package-scoped bootstrap token because npm cannot configure a trusted publisher for a package that does not yet exist. Store such a token only as a protected environment secret, remove and revoke it immediately after bootstrap, configure the trusted publisher separately for each npm package, and then disallow traditional token publication.

Registry creation, trusted-publisher setup, GitHub environment configuration, secrets, approvals, and first publication are external operations. They are not performed by repository implementation or local validation.
