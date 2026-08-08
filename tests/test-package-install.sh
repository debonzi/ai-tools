#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$root/packages/dbz-skills"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

npm pack --ignore-scripts --pack-destination "$temporary" "$workspace" >/dev/null
archive="$(find "$temporary" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
[ -n "$archive" ]
mkdir -p "$temporary/unpacked"
tar -xzf "$archive" -C "$temporary/unpacked"
package_root="$temporary/unpacked/package"

export HOME="$temporary/home"
export PI_CODING_AGENT_DIR="$temporary/agent"
export PI_OFFLINE=1
mkdir -p "$HOME"

pi -e "$package_root" --list-models >/dev/null
pi install "$package_root" >/dev/null
pi list | grep -Fq "$package_root"

python3 - "$package_root" <<'PY'
import json
from pathlib import Path
import sys

package_root = Path(sys.argv[1])
package = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
assert package["name"] == "@debonzi/dbz-skills"
assert package["pi"] == {"skills": ["./skills"]}
assert (package_root / "skills/dbz-issues/SKILL.md").is_file()
assert (package_root / "skills/dbz-spec/SKILL.md").is_file()
assert "extensions" not in package["pi"]
PY

printf '%s\n' 'DBZ Skills local package installation test passed.'
