SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REMOTE ?= origin
BRANCH ?= main
VERSION ?=
TAG := v$(VERSION)
PACKAGE_VERSION = $$(node -p 'require("./package.json").version')

.DEFAULT_GOAL := help

.PHONY: help release-preflight release-prepare release-commit release-check release-tag release-push full-release _require-version _require-main _require-clean _require-current-version _require-remote-main _require-new-tag _require-current-tag

help:
	@printf '%s\n' \
	  'Release targets:' \
	  '  make release-preflight VERSION=X.Y.Z  Verify branch, worktree, remote main, and tag availability.' \
	  '  make release-prepare                Apply Changesets and synchronize package-lock.json.' \
	  '  make release-commit VERSION=X.Y.Z   Commit the release metadata created by release-prepare.' \
	  '  make release-check VERSION=X.Y.Z    Run checks and verify the release commit is taggable.' \
	  '  make release-tag VERSION=X.Y.Z      Create the local annotated vX.Y.Z tag.' \
	  '  make release-push VERSION=X.Y.Z     Atomically push main and vX.Y.Z.' \
	  '  make full-release                   Prepare, commit, validate, tag, and atomically push.' \
	  '' \
	  'release-prepare and full-release derive their version from pending Changesets.' \
	  'The initial v0.1.0 bootstrap starts with release-tag after its metadata is merged.' \
	  'Override REMOTE=origin or BRANCH=main only when repository policy requires it.'

_require-version:
	@if [[ ! "$(VERSION)" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then \
	  echo 'VERSION must use an X.Y.Z SemVer number.' >&2; \
	  exit 2; \
	fi

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

_require-current-version:
	@if [[ "$(PACKAGE_VERSION)" != "$(VERSION)" ]]; then \
	  echo "package.json is version $(PACKAGE_VERSION), expected $(VERSION)." >&2; \
	  exit 1; \
	fi

_require-remote-main:
	@git fetch --quiet "$(REMOTE)" "$(BRANCH)"
	@if ! git merge-base --is-ancestor "$(REMOTE)/$(BRANCH)" HEAD; then \
	  echo "Local $(BRANCH) does not include the latest $(REMOTE)/$(BRANCH)." >&2; \
	  exit 1; \
	fi

_require-new-tag:
	@if git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null; then \
	  echo "Local tag $(TAG) already exists." >&2; \
	  exit 1; \
	fi
	@remote_tag="$$(git ls-remote --tags "$(REMOTE)" "refs/tags/$(TAG)")"; \
	if [[ -n "$$remote_tag" ]]; then \
	  echo "Remote tag $(TAG) already exists." >&2; \
	  exit 1; \
	fi

_require-current-tag:
	@if [[ "$$(git cat-file -t "refs/tags/$(TAG)" 2>/dev/null || true)" != 'tag' ]]; then \
	  echo "$(TAG) must be an annotated local tag." >&2; \
	  exit 1; \
	fi
	@if [[ "$$(git rev-parse "$(TAG)^{}")" != "$$(git rev-parse HEAD)" ]]; then \
	  echo "$(TAG) must point to the current $(BRANCH) commit." >&2; \
	  exit 1; \
	fi

release-preflight: _require-version _require-main _require-clean _require-remote-main _require-new-tag

release-prepare: _require-main _require-clean _require-remote-main
	npx changeset version
	npm install --package-lock-only --ignore-scripts
	@release_version="$$(node -p 'require("./package.json").version')"; \
	$(MAKE) --no-print-directory _require-version VERSION="$$release_version"; \
	$(MAKE) --no-print-directory _require-new-tag VERSION="$$release_version" REMOTE="$(REMOTE)"

release-commit: _require-version _require-main _require-current-version
	@if [[ -n "$$(git diff --cached --name-only)" ]]; then \
	  echo 'release-commit expects no pre-staged changes.' >&2; \
	  exit 1; \
	fi
	@unexpected="$$(git diff --name-only | grep -Ev '^(CHANGELOG\.md|package(-lock)?\.json|\.changeset/[^/]+\.md)$$' || true)"; \
	if [[ -n "$$unexpected" ]]; then \
	  echo 'release-commit found changes outside release metadata:' >&2; \
	  echo "$$unexpected" >&2; \
	  exit 1; \
	fi
	git add CHANGELOG.md package.json package-lock.json
	git add -u -- .changeset
	@if git diff --cached --quiet; then \
	  echo 'release-commit found no release metadata to commit.' >&2; \
	  exit 1; \
	fi
	git diff --cached --check
	git commit -m "chore: release v$(VERSION)"

release-check: release-preflight _require-current-version
	@if [[ -n "$$(find .changeset -maxdepth 1 -type f -name '*.md' ! -name README.md -print -quit)" ]]; then \
	  echo 'Release commit still has pending Changesets.' >&2; \
	  exit 1; \
	fi
	npm run check
	npm run pack:check

release-tag: release-check
	git tag -a "$(TAG)" -m "Release $(TAG)" HEAD

release-push: _require-version _require-main _require-clean _require-remote-main _require-current-version _require-current-tag
	@remote_tag="$$(git ls-remote --tags "$(REMOTE)" "refs/tags/$(TAG)")"; \
	if [[ -n "$$remote_tag" ]]; then \
	  echo "Remote tag $(TAG) already exists." >&2; \
	  exit 1; \
	fi
	git push --atomic "$(REMOTE)" "$(BRANCH)" "$(TAG)"

full-release:
	@$(MAKE) --no-print-directory release-prepare REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
	@release_version="$$(node -p 'require("./package.json").version')"; \
	$(MAKE) --no-print-directory release-commit VERSION="$$release_version" REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"; \
	$(MAKE) --no-print-directory release-tag VERSION="$$release_version" REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"; \
	$(MAKE) --no-print-directory release-push VERSION="$$release_version" REMOTE="$(REMOTE)" BRANCH="$(BRANCH)"
