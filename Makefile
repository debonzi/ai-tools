SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

PI_NODE_MODULES ?=
PI_BIN ?= pi

.PHONY: check test-behavior test-install

check: test-behavior test-install

# Reuse the host Pi's dependencies without installing anything into this repository.
test-behavior:
	@if [[ -z "$(PI_NODE_MODULES)" || ! -d "$(PI_NODE_MODULES)/@earendil-works/pi-coding-agent" ]]; then \
	  echo 'Set PI_NODE_MODULES to the node_modules directory containing the test version of Pi.' >&2; \
	  exit 1; \
	fi
	@host="$$(cd -- "$(PI_NODE_MODULES)" && pwd -P)"; \
	  temporary="$$(mktemp -d .test-run.XXXXXX)"; \
	  trap 'rm -rf -- "$$temporary"' EXIT; \
	  cp -R -- extensions tests "$$temporary/"; \
	  ln -s -- "$$host" "$$temporary/node_modules"; \
	  TZ=UTC node --test "$$temporary"/tests/*.test.ts

test-install:
	bash -n tests/test-package-install.sh
	PI_BIN="$(PI_BIN)" bash tests/test-package-install.sh
