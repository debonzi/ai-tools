# DB11 external cutover runbook

This runbook is the executable plan for renaming the GitHub repository, creating and publishing the DB11 npm identities, deprecating former package identities, validating redirects and release tags, and communicating the migration. Preparing or editing this document does not authorize any remote read or write.

## Authorization and safety rules

Treat each row below as a separate authorization gate. Record the approver, operator, approved target, and time window before running any command in that row.

| Gate | Remote targets | Allowed operations |
| --- | --- | --- |
| GitHub inventory | `debonzi/dbz-ai-tools`, then `debonzi/db11-ai-tools` | Read repository, Actions, environment, tag, redirect, and protection state |
| GitHub mutation | The same repository only | Rename the repository, configure the `npm` environment and secret, push `main` and approved package tags, rerun failed release jobs |
| Dependency download | `registry.npmjs.org` packages fixed by `package-lock.json` | Download public dependencies needed for local and workflow validation; no account or package mutation |
| npm inventory | `@debonzi/db11-skills`, `@debonzi/db11-crew`, `@debonzi/pi-codex-usage`, `@debonzi/dbz-skills`, `@debonzi/dbz-crew`, and `@debonzi/dbz-ai-tools` | Read package, version, dist-tag, deprecation, and trusted-publisher state |
| npm bootstrap publication | `@debonzi/db11-skills` and `@debonzi/db11-crew` only | Publish each approved initial version through the protected GitHub workflow with a short-lived bootstrap token |
| npm trusted publishing | The three DB11 repository packages | Create or update the trusted-publisher bindings for `debonzi/db11-ai-tools`, `release.yml`, and environment `npm` |
| npm deprecation | `@debonzi/dbz-skills`, `@debonzi/dbz-crew`, and `@debonzi/dbz-ai-tools` only | Set or, during rollback, clear the approved deprecation messages |

Authorization for one gate does not authorize another. In particular, permission to rename GitHub does not authorize npm publication or deprecation. Never print, commit, or save npm tokens in the evidence log, shell history, repository, or workflow output. Do not unpublish packages, delete or move published tags, create an aggregate `@debonzi/db11-ai-tools` package, or reuse the old GitHub slug.

## Fixed identities and release order

| Order | Selector | Workspace | npm identity | Initial or next tag |
| --- | --- | --- | --- | --- |
| 1 | `db11-skills` | `packages/db11-skills` | `@debonzi/db11-skills` | `db11-skills-vX.Y.Z` |
| 2 | `db11-crew` | `packages/db11-crew` | `@debonzi/db11-crew` | `db11-crew-vX.Y.Z` |
| 3 | `pi-codex-usage` | `packages/pi-codex-usage` | `@debonzi/pi-codex-usage` | `pi-codex-usage-vX.Y.Z` |

The first two are new npm identities. `@debonzi/pi-codex-usage` keeps its npm identity but must receive its DB11 repository metadata update. Former DBZ tags remain historical and must not be recreated under DB11 versions or moved to new commits.

Use the ordered phases below. Do not deprecate any former package until all selected successors are published and independently installable.

## Phase 0 — Open the cutover record

- [ ] Assign one GitHub operator, one npm operator, one release approver, and one communications owner.
- [ ] Record the cutover start, expected duration, and abort deadline.
- [ ] Create a private evidence directory outside the repository and restrict it to the current user.
- [ ] Obtain every authorization gate needed for the planned phase.
- [ ] Announce the maintenance window and ask maintainers not to push, tag, publish, deprecate, or rename related resources during it.

Run all command blocks in the same dedicated shell so the exported values and fail-closed options remain active. Set local, non-secret variables:

```sh
set -euo pipefail
export OLD_REPO='debonzi/dbz-ai-tools'
export NEW_REPO='debonzi/db11-ai-tools'
export OLD_REPO_URL='https://github.com/debonzi/dbz-ai-tools.git'
export NEW_REPO_URL='https://github.com/debonzi/db11-ai-tools.git'
export CUTOVER_EVIDENCE="$HOME/db11-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$CUTOVER_EVIDENCE"
```

Store command output that contains no credentials in that directory. Record checksums or URLs for published artifacts; do not copy npm or GitHub authentication state.

## Phase 1 — Freeze and validate the local release source

These checks must pass from clean `main` before any remote mutation. They change only the local checkout, but `npm ci` may download the locked public dependencies and therefore requires the dependency-download gate:

```sh
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=all)"
npm ci
npm run check
npm run pack:check

git rev-parse HEAD | tee "$CUTOVER_EVIDENCE/source-commit.txt"
node -p "require('./packages/db11-skills/package.json').version" \
  | tee "$CUTOVER_EVIDENCE/db11-skills-version.txt"
node -p "require('./packages/db11-crew/package.json').version" \
  | tee "$CUTOVER_EVIDENCE/db11-crew-version.txt"
node -p "require('./packages/pi-codex-usage/package.json').version" \
  | tee "$CUTOVER_EVIDENCE/pi-codex-usage-version-before-prepare.txt"
```

- [ ] Confirm the root manifest is private and has no publishable version.
- [ ] Confirm package names, repository URLs, workspaces, and tag selectors match the fixed table above.
- [ ] Confirm the residual-name audit contains only the classifications in [`db11-rename-policy.md`](db11-rename-policy.md).
- [ ] Confirm no credentials, sessions, histories, caches, trust decisions, or generated state are tracked.

Stop if any local check fails. Fix and review locally, make a normal commit, rerun this phase, and obtain a new source-commit approval.

## Phase 2 — Inventory remote state without mutation

Run this phase only after the GitHub-inventory and npm-inventory gates are approved.

```sh
gh auth status
gh repo view "$OLD_REPO" --json nameWithOwner,url,defaultBranchRef \
  | tee "$CUTOVER_EVIDENCE/github-before.json"
git ls-remote --heads --tags "$OLD_REPO_URL" \
  | tee "$CUTOVER_EVIDENCE/git-refs-before.txt"

npm whoami | tee "$CUTOVER_EVIDENCE/npm-operator.txt"
for package in \
  '@debonzi/db11-skills' \
  '@debonzi/db11-crew' \
  '@debonzi/pi-codex-usage' \
  '@debonzi/dbz-skills' \
  '@debonzi/dbz-crew' \
  '@debonzi/dbz-ai-tools'
do
  npm view "$package" name versions dist-tags deprecated --json \
    >"$CUTOVER_EVIDENCE/npm-$(printf '%s' "$package" | tr '/@' '__').json" \
    || printf '%s\n' "$package: not found or inaccessible" \
      >"$CUTOVER_EVIDENCE/npm-$(printf '%s' "$package" | tr '/@' '__').not-found"
done
```

Review the output instead of treating every `not found` result as expected.

- [ ] Confirm the old GitHub repository is the intended target and `main` is its default branch.
- [ ] Confirm `debonzi/db11-ai-tools` is available and is not an unrelated repository.
- [ ] Confirm the npm operator controls the `@debonzi` scope and only the intended packages.
- [ ] Confirm each new npm identity is either absent or already owned and exactly matches the approved bootstrap state.
- [ ] Record every former package version and current deprecation state for rollback.
- [ ] Record existing DBZ and other historical tags; they must remain byte-for-byte unchanged.

Stop on unexpected ownership, an occupied GitHub target, unexplained package content, an active conflicting release, or insufficient privileges.

## Phase 3 — Prepare release metadata locally

If pending Changesets exist, consume and commit them before the repository rename. This may contact the approved Git remote for the `main` ancestry check but does not publish or tag a package.

```sh
if find .changeset -maxdepth 1 -type f -name '*.md' ! -name README.md -print -quit \
  | grep -q .
then
  make release-prepare
  git diff --check
  git diff -- package-lock.json packages/*/package.json packages/*/CHANGELOG.md .changeset
  make release-commit
fi

test -z "$(git status --porcelain --untracked-files=all)"
export DB11_SKILLS_VERSION="$(node -p "require('./packages/db11-skills/package.json').version")"
export DB11_CREW_VERSION="$(node -p "require('./packages/db11-crew/package.json').version")"
export PI_CODEX_USAGE_VERSION="$(node -p "require('./packages/pi-codex-usage/package.json').version")"

make release-info PACKAGE=db11-skills VERSION="$DB11_SKILLS_VERSION"
make release-info PACKAGE=db11-crew VERSION="$DB11_CREW_VERSION"
make release-info PACKAGE=pi-codex-usage VERSION="$PI_CODEX_USAGE_VERSION"
```

The DB11 package identities may start at their already committed `0.1.0` manifests without a Changesets version step. Never add a version to the private root.

## Phase 4 — Rename GitHub and restore release controls

Run this phase only with GitHub-mutation authorization for the named repository.

1. Rename the repository without changing its owner, visibility, default branch, or history:

   ```sh
   gh repo rename db11-ai-tools --repo "$OLD_REPO" --yes
   ```

2. Point the local `origin` at the canonical new URL and verify the identity:

   ```sh
   git remote set-url origin "$NEW_REPO_URL"
   test "$(git remote get-url origin)" = "$NEW_REPO_URL"
   gh repo view "$NEW_REPO" --json nameWithOwner,url,defaultBranchRef \
     | tee "$CUTOVER_EVIDENCE/github-after.json"
   git fetch --prune origin main
   git merge-base --is-ancestor origin/main HEAD
   ```

3. In the renamed repository, verify or recreate the protected GitHub environment named exactly `npm`:

   - require the approved reviewers and prevent self-approval where policy supports it;
   - restrict deployment branches or tags to the three package tag families;
   - retain `contents: read` and grant `id-token: write` only to the publish job;
   - confirm Actions can run `release.yml` and that branch/tag protections survived the rename.

4. Update the npm trusted-publisher record for the existing `@debonzi/pi-codex-usage` identity to:

   | Field | Value |
   | --- | --- |
   | Owner | `debonzi` |
   | Repository | `db11-ai-tools` |
   | Workflow | `release.yml` |
   | Environment | `npm` |

5. If the two new identities do not yet exist, create one short-lived, least-privilege npm bootstrap token with the shortest practical expiration. Add it as the protected `npm` environment secret `NPM_PUBLISH_TOKEN` using an approved secret-entry UI or a prompt that does not expose it in shell history. Do not place the value in this runbook's variables or evidence.

Stop if protections, approvals, environment identity, or the existing trusted-publisher binding cannot be verified under the new repository slug.

## Phase 5 — Publish the two new npm identities

Publish one package at a time. The Make targets create annotated package-qualified tags locally and atomically push only `main` plus the selected tag. The protected workflow performs publication; local `npm publish` is prohibited.

For `@debonzi/db11-skills`:

```sh
make release-preflight PACKAGE=db11-skills VERSION="$DB11_SKILLS_VERSION"
make release-check PACKAGE=db11-skills VERSION="$DB11_SKILLS_VERSION"
make release-tag PACKAGE=db11-skills VERSION="$DB11_SKILLS_VERSION"
make release-push PACKAGE=db11-skills VERSION="$DB11_SKILLS_VERSION"

export RELEASE_TAG="db11-skills-v$DB11_SKILLS_VERSION"
export RUN_ID="$(gh run list --repo "$NEW_REPO" --workflow release.yml \
  --branch "$RELEASE_TAG" --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo "$NEW_REPO" --exit-status
npm view "@debonzi/db11-skills@$DB11_SKILLS_VERSION" name version dist-tags --json \
  | tee "$CUTOVER_EVIDENCE/db11-skills-published.json"
```

For `@debonzi/db11-crew`:

```sh
make release-preflight PACKAGE=db11-crew VERSION="$DB11_CREW_VERSION"
make release-check PACKAGE=db11-crew VERSION="$DB11_CREW_VERSION"
make release-tag PACKAGE=db11-crew VERSION="$DB11_CREW_VERSION"
make release-push PACKAGE=db11-crew VERSION="$DB11_CREW_VERSION"

export RELEASE_TAG="db11-crew-v$DB11_CREW_VERSION"
export RUN_ID="$(gh run list --repo "$NEW_REPO" --workflow release.yml \
  --branch "$RELEASE_TAG" --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo "$NEW_REPO" --exit-status
npm view "@debonzi/db11-crew@$DB11_CREW_VERSION" name version dist-tags --json \
  | tee "$CUTOVER_EVIDENCE/db11-crew-published.json"
```

After each initial publication:

- [ ] Verify the workflow used the protected `npm` environment and the approved commit.
- [ ] Verify package name, version, provenance, public access, archive contents, and `latest` dist-tag.
- [ ] Configure that package's trusted publisher with the same owner, repository, workflow, and environment table used above.
- [ ] Do not proceed to the next package if publication or verification is ambiguous.

After both new trusted publishers are configured, delete `NPM_PUBLISH_TOKEN` from the GitHub environment, revoke the bootstrap token at npm, and record only the revocation time and token description. Confirm the workflow has no repository-, organization-, or environment-level token fallback before continuing.

## Phase 6 — Publish the existing package metadata update

Publish `@debonzi/pi-codex-usage` only after the bootstrap token is removed, so this run verifies the renamed repository's trusted-publishing path.

```sh
make release-preflight PACKAGE=pi-codex-usage VERSION="$PI_CODEX_USAGE_VERSION"
make release-check PACKAGE=pi-codex-usage VERSION="$PI_CODEX_USAGE_VERSION"
make release-tag PACKAGE=pi-codex-usage VERSION="$PI_CODEX_USAGE_VERSION"
make release-push PACKAGE=pi-codex-usage VERSION="$PI_CODEX_USAGE_VERSION"

export RELEASE_TAG="pi-codex-usage-v$PI_CODEX_USAGE_VERSION"
export RUN_ID="$(gh run list --repo "$NEW_REPO" --workflow release.yml \
  --branch "$RELEASE_TAG" --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo "$NEW_REPO" --exit-status
npm view "@debonzi/pi-codex-usage@$PI_CODEX_USAGE_VERSION" name version dist-tags --json \
  | tee "$CUTOVER_EVIDENCE/pi-codex-usage-published.json"
```

Stop if the trusted publisher fails. Do not restore a long-lived npm token as a fallback; correct the binding or workflow and rerun the failed job after approval.

## Phase 7 — Validate packages, tags, and redirects

Run only with the corresponding inventory authorizations still active.

```sh
for spec in \
  "@debonzi/db11-skills@$DB11_SKILLS_VERSION" \
  "@debonzi/db11-crew@$DB11_CREW_VERSION" \
  "@debonzi/pi-codex-usage@$PI_CODEX_USAGE_VERSION"
do
  npm view "$spec" name version repository dist-tags deprecated --json
  npm pack "$spec" --dry-run --json >/dev/null
done

git ls-remote --heads --tags "$NEW_REPO_URL" \
  | tee "$CUTOVER_EVIDENCE/git-refs-after.txt"
redirect_target="$(curl -LsS -o /dev/null -w '%{url_effective}' \
  'https://github.com/debonzi/dbz-ai-tools')"
case "$redirect_target" in
  'https://github.com/debonzi/db11-ai-tools'|'https://github.com/debonzi/db11-ai-tools/') ;;
  *) printf 'Unexpected GitHub redirect: %s\n' "$redirect_target" >&2; exit 1 ;;
esac
git ls-remote "$OLD_REPO_URL" HEAD >/dev/null
```

- [ ] Confirm all three pushed tags are annotated and resolve to the approved commit.
- [ ] Diff the before/after ref inventories and confirm every historical DBZ tag is unchanged.
- [ ] Confirm both the old browser URL and old Git remote URL redirect to the renamed repository.
- [ ] Confirm no replacement repository occupies `debonzi/dbz-ai-tools`; that would break GitHub redirects.
- [ ] Confirm package metadata links directly to `debonzi/db11-ai-tools` rather than relying on the redirect.
- [ ] Perform isolated Pi installations of all three packages and confirm their declared resources load without extension errors:

```sh
PI_SMOKE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PI_SMOKE_ROOT"' EXIT
install -d -m 700 "$PI_SMOKE_ROOT/home" "$PI_SMOKE_ROOT/agent"
(
  export HOME="$PI_SMOKE_ROOT/home"
  export XDG_CONFIG_HOME="$PI_SMOKE_ROOT/config"
  export XDG_STATE_HOME="$PI_SMOKE_ROOT/state"
  export PI_CODING_AGENT_DIR="$PI_SMOKE_ROOT/agent"
  export PI_CODING_AGENT_SESSION_DIR="$PI_SMOKE_ROOT/sessions"
  export GIT_TERMINAL_PROMPT=0
  pi install npm:@debonzi/db11-skills
  pi install npm:@debonzi/db11-crew
  pi install npm:@debonzi/pi-codex-usage
  pi list --no-approve >"$PI_SMOKE_ROOT/pi-list.txt"
  export PI_OFFLINE=1
  printf '%s\n' '{"type":"get_commands"}' | \
    pi --mode rpc --no-session --no-context-files --no-approve --offline \
    >"$PI_SMOKE_ROOT/rpc.jsonl"
)
python3 - "$PI_SMOKE_ROOT/rpc.jsonl" <<'PY'
import json
from pathlib import Path
import sys

records = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line]
assert not [record for record in records if record.get("type") == "extension_error"], records
responses = [
    record for record in records
    if record.get("type") == "response"
    and record.get("command") == "get_commands"
    and record.get("success") is True
]
assert len(responses) == 1, records
names = {command["name"] for command in responses[0]["data"]["commands"]}
assert {"skill:db11-issues", "skill:db11-spec", "skill:db11-crew", "skill:db11-crew-setup", "usage-codex"} <= names
PY
```

If a redirect fails, communicate the canonical URL explicitly and stop before deprecation. npm package names do not redirect; only deprecation messages and migration documentation connect old package identities to successors.

## Phase 8 — Deprecate former npm identities

Run only after Phases 5–7 pass and with explicit npm-deprecation authorization for all three old identities. Deprecation is a warning, not deletion; keep every historical version available. Run a command below only when Phase 2 proved that identity exists and is controlled by the approved operator. If a former split-package identity was never published, record it as not applicable; never publish an old identity merely to deprecate it.

```sh
npm deprecate '@debonzi/dbz-skills@*' \
  'Renamed to @debonzi/db11-skills. Migration: https://github.com/debonzi/db11-ai-tools/blob/main/packages/db11-skills/README.md#migrate-from-the-former-dbz-package'

npm deprecate '@debonzi/dbz-crew@*' \
  'Renamed to @debonzi/db11-crew. Finish old workers before migrating: https://github.com/debonzi/db11-ai-tools/blob/main/packages/db11-crew/README.md#migrate-from-the-former-dbz-runtime'

npm deprecate '@debonzi/dbz-ai-tools@*' \
  'Retired aggregate package. Choose @debonzi/db11-skills, @debonzi/db11-crew, and/or @debonzi/pi-codex-usage: https://github.com/debonzi/db11-ai-tools#migrate-from-the-former-aggregate-package'
```

Verify the exact messages and preserve the output in the evidence directory:

```sh
for package in \
  '@debonzi/dbz-skills' \
  '@debonzi/dbz-crew' \
  '@debonzi/dbz-ai-tools'
do
  npm view "$package@*" version deprecated --json \
    >"$CUTOVER_EVIDENCE/deprecated-$(printf '%s' "$package" | tr '/@' '__').json"
done
```

Stop if any old package is not controlled by the approved npm account, maps to a different successor, or contains a version that must remain undeprecated for an approved compatibility window.

## Phase 9 — Communicate and close the window

Publish one coordinated notice only after new package verification and deprecation succeed. Include:

- the canonical repository URL, `https://github.com/debonzi/db11-ai-tools`;
- the exact old-to-new package and resource mapping;
- the fact that there is no aggregate `@debonzi/db11-ai-tools` package;
- removal and installation commands from the root README;
- the requirement to review global and project Pi package filters and run `/reload` or restart Pi;
- DB11 Crew's hard namespace cutover, requirement to finish old workers first, untouched legacy state, and rollback guidance;
- independent package versions and new package-qualified tag families;
- support contact, cutover time, and known issues.

Update the approved release notes, package announcements, and maintainer channels. Do not claim that npm redirects package names or that old Pi filters migrate automatically.

Final checks:

```sh
git status --short --branch
gh run list --repo "$NEW_REPO" --workflow release.yml --limit 10
npm view '@debonzi/db11-skills' version dist-tags --json
npm view '@debonzi/db11-crew' version dist-tags --json
npm view '@debonzi/pi-codex-usage' version dist-tags --json
```

- [ ] Confirm the worktree is clean and `origin` uses the canonical URL.
- [ ] Confirm the maintenance freeze can end.
- [ ] Record publication URLs, workflow run URLs, tag object IDs, deprecation evidence, redirect checks, token revocation, and communications links.
- [ ] Record every skipped package or phase explicitly; partial cutovers must not be presented as complete.

## Abort and rollback matrix

| Point of failure | Required response |
| --- | --- |
| Before GitHub rename | Stop with no remote mutation. Fix locally and repeat approvals. |
| After rename, before a package tag is pushed | If no public DB11 artifact or communication depends on the new slug, separately authorize renaming the repository back and restore the old `origin`; otherwise keep the new slug and fix forward. |
| Tag pushed, workflow not yet published | Do not move or delete the tag. Correct environment, approval, or trusted-publisher configuration and rerun the same workflow job. If the tag or manifest is wrong, leave it as failed history and release a new version from a new commit and tag. |
| One new npm identity published | Treat the version as immutable. Do not unpublish. Keep former packages active and undeprecated, correct forward with a new version if needed, and communicate that the cutover is partial. |
| Bootstrap token exposed or retained | Stop publication, delete the GitHub secret, revoke the npm token, inspect authorized audit logs, and issue a replacement only with new authorization. |
| Trusted publishing fails after bootstrap | Do not restore a long-lived token fallback. Correct the owner/repository/workflow/environment binding and rerun after approval. |
| Former package deprecated too early or with a wrong message | Clear its deprecation with `npm deprecate '<package>@*' ''`, verify every version, correct the successor, and reapply only after authorization. |
| GitHub redirect fails | Keep the canonical DB11 URL in communication, do not reuse the old slug, and resolve the rename conflict before deprecating packages. |
| Defect found after all publications | Keep published versions and tags immutable, halt further announcements if practical, publish a reviewed patch under the DB11 identity, and clear old-package deprecations temporarily only if consumers need the old line. |

Any rollback command that changes GitHub or npm requires fresh authorization for that exact target. Rollback must not delete historical packages, tags, repository history, legacy DBZ Crew state, or current DB11 Crew state.
