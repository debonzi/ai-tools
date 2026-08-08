SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REMOTE ?= origin
BRANCH ?= main
PACKAGE ?=
VERSION ?=
RELEASE_IDENTITY := python3 scripts/release_identity.py

.DEFAULT_GOAL := help
.NOTPARALLEL:

.PHONY: help release-info release-preflight release-prepare release-commit release-check release-tag release-push \
	_require-main _require-clean _require-remote-main _require-new-tag _require-current-tag

help:
	@printf '%s\n' \
	  'Release targets:' \
	  '  make release-info PACKAGE=db11-crew VERSION=X.Y.Z       Validate and print the fixed package identity.' \
	  '  make release-preflight PACKAGE=db11-crew VERSION=X.Y.Z  Verify branch, worktree, manifest, remote main, and tag availability.' \
	  '  make release-prepare                                    Apply pending Changesets and synchronize package-lock.json.' \
	  '  make release-commit                                     Commit only release metadata created by release-prepare.' \
	  '  make release-check PACKAGE=db11-crew VERSION=X.Y.Z      Install dependencies and run all validation before tagging.' \
	  '  make release-tag PACKAGE=db11-crew VERSION=X.Y.Z        Create the selected package-qualified annotated tag.' \
	  '  make release-push PACKAGE=db11-crew VERSION=X.Y.Z       Atomically push main and only the selected tag.' \
	  '' \
	  'PACKAGE must be db11-skills, db11-crew, or pi-codex-usage.' \
	  'Local release targets never publish npm packages.' \
	  'Override REMOTE=origin or BRANCH=main only when repository policy requires it.'

release-info:
	@$(RELEASE_IDENTITY) --package "$(PACKAGE)" --version "$(VERSION)" --verify-manifest

_require-main:
	@if [[ "$$(git branch --show-current)" != "$(BRANCH)" ]]; then \
	  echo "Release targets must run from $(BRANCH)." >&2; \
	  exit 1; \
	fi

_require-clean:
	@if [[ -n "$$(git status --porcelain --untracked-files=all)" ]]; then \
	  echo 'Release targets require a clean worktree.' >&2; \
	  exit 1; \
	fi

_require-remote-main:
	@git fetch --quiet "$(REMOTE)" "$(BRANCH)"
	@if ! git show-ref --verify --quiet "refs/remotes/$(REMOTE)/$(BRANCH)"; then \
	  echo "Remote branch $(REMOTE)/$(BRANCH) is unavailable." >&2; \
	  exit 1; \
	fi
	@if ! git merge-base --is-ancestor "$(REMOTE)/$(BRANCH)" HEAD; then \
	  echo "Local $(BRANCH) does not include the latest $(REMOTE)/$(BRANCH)." >&2; \
	  exit 1; \
	fi

_require-new-tag:
	@identity="$$($(RELEASE_IDENTITY) --package "$(PACKAGE)" --version "$(VERSION)" --format shell --verify-manifest)"; \
	eval "$$identity"; \
	if git rev-parse -q --verify "refs/tags/$$TAG" >/dev/null; then \
	  echo "Local tag $$TAG already exists." >&2; \
	  exit 1; \
	fi; \
	remote_tag="$$(git ls-remote --tags "$(REMOTE)" "refs/tags/$$TAG")"; \
	if [[ -n "$$remote_tag" ]]; then \
	  echo "Remote tag $$TAG already exists." >&2; \
	  exit 1; \
	fi

_require-current-tag:
	@identity="$$($(RELEASE_IDENTITY) --package "$(PACKAGE)" --version "$(VERSION)" --format shell --verify-manifest)"; \
	eval "$$identity"; \
	if [[ "$$(git cat-file -t "refs/tags/$$TAG" 2>/dev/null || true)" != 'tag' ]]; then \
	  echo "$$TAG must be an annotated local tag." >&2; \
	  exit 1; \
	fi; \
	if [[ "$$(git rev-parse "$$TAG^{}")" != "$$(git rev-parse HEAD)" ]]; then \
	  echo "$$TAG must point to the current $(BRANCH) commit." >&2; \
	  exit 1; \
	fi

release-preflight:
	@$(MAKE) --no-print-directory release-info PACKAGE="$(PACKAGE)" VERSION="$(VERSION)"
	@$(MAKE) --no-print-directory _require-main BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-clean
	@$(MAKE) --no-print-directory _require-remote-main REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-new-tag PACKAGE="$(PACKAGE)" VERSION="$(VERSION)" REMOTE="$(REMOTE)"

release-prepare:
	@$(MAKE) --no-print-directory _require-main BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-clean
	@$(MAKE) --no-print-directory _require-remote-main REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@if [[ -z "$$(find .changeset -maxdepth 1 -type f -name '*.md' ! -name README.md -print -quit)" ]]; then \
	  echo 'release-prepare requires at least one pending Changeset.' >&2; \
	  exit 1; \
	fi
	npx changeset version
	npm install --package-lock-only --ignore-scripts

release-commit:
	@$(MAKE) --no-print-directory _require-main BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-remote-main REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@if [[ -n "$$(git diff --cached --name-only)" ]]; then \
	  echo 'release-commit expects no pre-staged changes.' >&2; \
	  exit 1; \
	fi
	@status_output="$$(git status --porcelain=v1 --untracked-files=all)"; \
	if [[ -z "$$status_output" ]]; then \
	  echo 'release-commit found no release metadata to commit.' >&2; \
	  exit 1; \
	fi; \
	unexpected=''; \
	while IFS= read -r line; do \
	  status="$${line:0:2}"; \
	  path="$${line:3}"; \
	  case "$$status:$$path" in \
	    ' M:package-lock.json'|\
	    ' M:packages/db11-skills/package.json'|\
	    ' M:packages/db11-skills/CHANGELOG.md'|\
	    ' M:packages/db11-crew/package.json'|\
	    ' M:packages/db11-crew/CHANGELOG.md'|\
	    ' M:packages/pi-codex-usage/package.json'|\
	    ' M:packages/pi-codex-usage/CHANGELOG.md') ;; \
	    ' D:.changeset/'*.md) \
	      [[ "$$path" != '.changeset/README.md' ]] || unexpected+="$$line"$$'\n' ;; \
	    *) unexpected+="$$line"$$'\n' ;; \
	  esac; \
	done <<< "$$status_output"; \
	if [[ -n "$$unexpected" ]]; then \
	  echo 'release-commit found changes outside generated release metadata:' >&2; \
	  printf '%s' "$$unexpected" >&2; \
	  exit 1; \
	fi; \
	changed="$$(git diff --name-only)"; \
	if ! grep -qE '^\.changeset/[^/]+\.md$$' <<< "$$changed"; then \
	  echo 'release-commit found no consumed Changeset.' >&2; \
	  exit 1; \
	fi; \
	updated=0; \
	for workspace in db11-skills db11-crew pi-codex-usage; do \
	  manifest="packages/$$workspace/package.json"; \
	  changelog="packages/$$workspace/CHANGELOG.md"; \
	  manifest_changed=0; changelog_changed=0; \
	  grep -Fxq "$$manifest" <<< "$$changed" && manifest_changed=1 || true; \
	  grep -Fxq "$$changelog" <<< "$$changed" && changelog_changed=1 || true; \
	  if [[ $$manifest_changed -ne $$changelog_changed ]]; then \
	    echo "release-commit requires $$manifest and $$changelog to change together." >&2; \
	    exit 1; \
	  fi; \
	  updated=$$((updated + manifest_changed)); \
	done; \
	if [[ $$updated -eq 0 ]]; then \
	  echo 'release-commit found no versioned workspace.' >&2; \
	  exit 1; \
	fi
	git add package-lock.json \
	  packages/db11-skills/package.json packages/db11-skills/CHANGELOG.md \
	  packages/db11-crew/package.json packages/db11-crew/CHANGELOG.md \
	  packages/pi-codex-usage/package.json packages/pi-codex-usage/CHANGELOG.md
	git add -u -- .changeset
	git diff --cached --check
	git commit -m "chore: version packages"

release-check:
	@$(MAKE) --no-print-directory release-preflight PACKAGE="$(PACKAGE)" VERSION="$(VERSION)" REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@if [[ -n "$$(find .changeset -maxdepth 1 -type f -name '*.md' ! -name README.md -print -quit)" ]]; then \
	  echo 'Release commit still has pending Changesets.' >&2; \
	  exit 1; \
	fi
	npm ci
	npm run check
	npm run pack:check
	@$(MAKE) --no-print-directory _require-clean
	@$(MAKE) --no-print-directory release-info PACKAGE="$(PACKAGE)" VERSION="$(VERSION)"

release-tag:
	@$(MAKE) --no-print-directory release-check PACKAGE="$(PACKAGE)" VERSION="$(VERSION)" REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@identity="$$($(RELEASE_IDENTITY) --package "$(PACKAGE)" --version "$(VERSION)" --format shell --verify-manifest)"; \
	eval "$$identity"; \
	git tag -a "$$TAG" -m "Release $$NPM_PACKAGE $$VERSION" HEAD

release-push:
	@$(MAKE) --no-print-directory release-info PACKAGE="$(PACKAGE)" VERSION="$(VERSION)"
	@$(MAKE) --no-print-directory _require-main BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-clean
	@$(MAKE) --no-print-directory _require-remote-main REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@$(MAKE) --no-print-directory _require-current-tag PACKAGE="$(PACKAGE)" VERSION="$(VERSION)"
	@identity="$$($(RELEASE_IDENTITY) --package "$(PACKAGE)" --version "$(VERSION)" --format shell --verify-manifest)"; \
	eval "$$identity"; \
	remote_tag="$$(git ls-remote --tags "$(REMOTE)" "refs/tags/$$TAG")"; \
	if [[ -n "$$remote_tag" ]]; then \
	  echo "Remote tag $$TAG already exists." >&2; \
	  exit 1; \
	fi; \
	git push --atomic "$(REMOTE)" "$(BRANCH)" "$$TAG"
