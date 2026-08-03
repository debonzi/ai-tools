#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

export HOME="$temporary/home"
export PI_CODING_AGENT_DIR="$temporary/agent"
export PI_OFFLINE=1
mkdir -p "$HOME"

pi -e "$root" --list-models >/dev/null
pi install "$root" >/dev/null
pi list | grep -Fq "$root"

plan="$(
    python3 "$root/skills/dbz-ai-tools-setup/scripts/configure.py" plan \
        --scope global \
        --skill dbz-spec
)"
digest="$(printf '%s' "$plan" | python3 -c 'import json, sys; print(json.load(sys.stdin)["before_sha256"])')"
python3 "$root/skills/dbz-ai-tools-setup/scripts/configure.py" apply \
    --scope global \
    --skill dbz-spec \
    --expected-sha256 "$digest" >/dev/null

python3 - "$PI_CODING_AGENT_DIR/settings.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as settings_file:
    settings = json.load(settings_file)
package = settings["packages"][0]
assert package["skills"] == [
    "skills/dbz-ai-tools-setup/SKILL.md",
    "skills/dbz-spec/SKILL.md",
]
assert package["extensions"] == []
PY

printf '%s\n' 'Pi package installation test passed.'
