# Releasing `@debonzi/dbz-ai-tools`

This document is the durable release procedure for maintainers. It is not a roadmap or a checklist for uncommitted work.

## Release contract

- Releases use Semantic Versioning and an annotated Git tag named `vX.Y.Z`.
- The tag must point to a commit already reachable from `main`.
- The tag version must exactly match `package.json`.
- Pushing the tag starts the **Release** workflow.
- Validation must pass before the publish job can request approval for the GitHub `npm` environment.
- After approval, npm publishes the public package with provenance.
- Normal releases use npm trusted publishing and GitHub Actions OIDC without a persistent npm token.

The workflow rejects lightweight tags, mismatched versions, and tags outside `main`. It intentionally has no manual publication trigger. Do not run `npm publish` from a local checkout.

## Changesets

Add a Changeset for every user-visible skill, extension, or package change:

```sh
npx changeset
```

Choose the SemVer impact and write a concise consumer-facing summary. Changesets are consumed when preparing a release.

## Routine release

The repository Makefile requires a clean local `main`, verifies that it contains the current remote `main`, rejects existing local or remote tags, and pushes `main` and the release tag atomically. It never runs `npm publish` locally.

```sh
make full-release
```

`full-release` derives the version from pending Changesets, updates `CHANGELOG.md`, synchronizes `package-lock.json`, commits only release metadata as `chore: release vX.Y.Z`, validates the package, creates the annotated tag, and pushes it.

For a review point between stages, first prepare the release and inspect the generated version. Substitute that version below:

```sh
make release-prepare
make release-commit VERSION=X.Y.Z
make release-tag VERSION=X.Y.Z
make release-push VERSION=X.Y.Z
```

Review the validation job and approve the pending deployment to the `npm` environment. Published npm versions are permanent and must never be reused.

## Trusted publisher configuration

The npm package must authorize exactly this GitHub Actions identity:

| Setting | Value |
| --- | --- |
| GitHub organization or user | `debonzi` |
| Repository | `dbz-ai-tools` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

After the package exists, configure it from npm package settings or interactively:

```sh
npm trust github @debonzi/dbz-ai-tools \
  --file release.yml \
  --repo debonzi/dbz-ai-tools \
  --env npm \
  --allow-publish
```

Confirm with `npm trust list @debonzi/dbz-ai-tools`. Then set **Publishing access** to **Require two-factor authentication and disallow tokens**.

## One-time initial-publication bootstrap

npm requires the package to exist before its trusted publisher can be configured. Version `0.1.0` is the initial registry version and is already represented in `package.json` and `CHANGELOG.md`; do not run `changeset version` for this unpublished baseline.

1. Create a short-lived granular npm token with write access limited to the `@debonzi` scope and the shortest practical expiry. Enable 2FA bypass only for this non-interactive bootstrap.
2. Create a protected GitHub environment named `npm` with required reviewers.
3. Add the token as the `NPM_PUBLISH_TOKEN` environment secret, never as a repository secret or tracked file.
4. After the release metadata is merged into `main`, run:

   ```sh
   make release-tag VERSION=0.1.0
   make release-push VERSION=0.1.0
   ```

5. Review validation and approve the `npm` environment deployment.
6. Configure the trusted publisher immediately after publication.
7. Remove the environment secret, revoke the temporary token, and disallow traditional token publishing.

The empty `NPM_PUBLISH_TOKEN` reference is harmless during normal releases because npm uses the GitHub OIDC trusted-publishing credential first.
