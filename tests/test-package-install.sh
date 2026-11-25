#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pi_bin="$(command -v "${PI_BIN:-pi}")"
pi_bin="$(realpath -- "$pi_bin")"
temporary="$(mktemp -d "$root/.test-run.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT

fixture="$temporary/source"
mkdir -p "$fixture" "$temporary"/{agent,home,work,bin,tmp}

# Use the working tree so the same check runs before commit and in CI. Only
# copy Git-visible resources; ignored local files never enter the fixture.
test ! -e "$root/package.json"
git -C "$root" ls-files -z --cached --others --exclude-standard \
    -- extensions skills prompts themes >"$temporary/paths"
(
    cd "$root"
    while IFS= read -r -d '' path; do
        if [[ -e "$path" || -L "$path" ]]; then
            cp -P --parents -- "$path" "$fixture"
        fi
    done <"$temporary/paths"
)

export HOME="$temporary/home"
export XDG_CONFIG_HOME="$temporary/config"
export XDG_STATE_HOME="$temporary/state"
export XDG_CACHE_HOME="$temporary/cache"
export TMPDIR="$temporary/tmp"
export PI_CODING_AGENT_DIR="$temporary/agent"
export PI_CODING_AGENT_SESSION_DIR="$temporary/sessions"
export PI_OFFLINE=1
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_ALLOW_PROTOCOL=file
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.file://$fixture.insteadOf"
export GIT_CONFIG_VALUE_0=https://github.com/debonzi/ai-tools

git -C "$fixture" init --quiet --initial-branch=main --template=
git -C "$fixture" add --all
git -C "$fixture" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m 'Package snapshot'
ref=package-test
git -C "$fixture" tag "$ref"
expected_commit="$(git -C "$fixture" rev-parse HEAD)"
git -C "$fixture" -c user.name=Test -c user.email=test@example.invalid commit --quiet --allow-empty -m 'Later commit'

# A package manager invocation during installation is a regression. The Pi
# test executable is already installed; this guard applies to its children.
printf '#!/bin/sh\necho "Unexpected package manager: $0" >&2\nexit 1\n' >"$temporary/bin/npm"
chmod +x "$temporary/bin/npm"
ln -s npm "$temporary/bin/pnpm"
ln -s npm "$temporary/bin/bun"
export PATH="$temporary/bin:$PATH"

mkdir -p "$PI_CODING_AGENT_DIR/extensions"
probe="$PI_CODING_AGENT_DIR/extensions/context-meter-probe.ts"
tee "$probe" >/dev/null <<'TS'
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const tools = pi.getAllTools()
      .filter((tool) => tool.sourceInfo?.origin === "package")
      .map(({ name, sourceInfo }) => ({ name, sourceInfo }));
    writeFileSync(process.env.AI_TOOLS_TEST_REPORT!, JSON.stringify(tools));
  });
}
TS

cd "$temporary/work"
source="git:github.com/debonzi/ai-tools@$ref"
"$pi_bin" install "$source"
"$pi_bin" list --no-approve >"$temporary/pi-list.txt"
grep -Fq "$source" "$temporary/pi-list.txt"
installed="$PI_CODING_AGENT_DIR/git/github.com/debonzi/ai-tools"
test "$(git -C "$installed" rev-parse HEAD)" = "$expected_commit"
test ! -e "$installed/package.json"
test ! -e "$installed/node_modules"
test ! -e "$PI_CODING_AGENT_DIR/trust.json"

probe_commands() {
    # Do not pass provider credentials or user-specific Pi overrides to the fixture.
    printf '%s\n' '{"type":"get_commands"}' | \
        env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" \
        XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_STATE_HOME="$XDG_STATE_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" \
        PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" PI_CODING_AGENT_SESSION_DIR="$PI_CODING_AGENT_SESSION_DIR" \
        PI_OFFLINE=1 GIT_ALLOW_PROTOCOL=file AI_TOOLS_TEST_REPORT="$temporary/$1-tools.json" \
        "$pi_bin" --mode rpc --no-session --no-context-files --no-approve --offline >"$temporary/$1.jsonl"
}

probe_commands all
python3 - "$PI_CODING_AGENT_DIR/settings.json" "$source" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = sys.argv[2]
settings = json.loads(path.read_text(encoding="utf-8"))
assert settings == {"packages": [source]}, settings
settings["packages"] = [{
    "source": source,
    "extensions": ["extensions/context-meter/index.ts"],
}]
path.write_text(json.dumps(settings), encoding="utf-8")
PY
probe_commands filtered

python3 - "$temporary" "$installed" <<'PY'
import json
from pathlib import Path
import sys

results = Path(sys.argv[1])
installed = Path(sys.argv[2]).resolve()
expected = {
    "usage-codex": "extensions/codex-usage/index.ts",
    "usage-copilot": "extensions/copilot-usage/index.ts",
}

for case in ("all", "filtered"):
    records = [json.loads(line) for line in (results / f"{case}.jsonl").read_text().splitlines() if line]
    assert not any(record.get("type") == "extension_error" for record in records), records
    responses = [r for r in records if r.get("type") == "response" and r.get("command") == "get_commands"]
    assert len(responses) == 1 and responses[0].get("success") is True, records
    commands = responses[0]["data"]["commands"]
    tools = json.loads((results / f"{case}-tools.json").read_text())
    assert [tool["name"] for tool in tools] == ["pi-context-meter"], tools
    assert Path(tools[0]["sourceInfo"]["path"]).resolve() == installed / "extensions/context-meter/index.ts"
    owned = [c for c in commands if c.get("sourceInfo", {}).get("origin") == "package"]
    if case == "filtered":
        assert not owned, owned
    else:
        assert sorted(command["name"] for command in owned) == sorted(expected), owned
        for command in owned:
            assert command["source"] == "extension", command
            assert Path(command["sourceInfo"]["baseDir"]).resolve() == installed, command
            assert Path(command["sourceInfo"]["path"]).resolve() == installed / expected[command["name"]], command
PY

echo 'Isolated Git installation and resource filtering passed.'
