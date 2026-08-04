#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

npm pack --ignore-scripts --pack-destination "$temporary" "$root" >/dev/null
archive="$(find "$temporary" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
[ -n "$archive" ] || fail "npm pack did not create an archive"
mkdir -p "$temporary/package-v2"
tar -xzf "$archive" -C "$temporary/package-v2" --strip-components=1
cp -a "$temporary/package-v2" "$temporary/package-v1"
python3 - "$temporary/package-v1/package.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as package_file:
    package = json.load(package_file)
package["version"] = "0.0.0"
with open(path, "w", encoding="utf-8") as package_file:
    json.dump(package, package_file, indent=2)
    package_file.write("\n")
PY
printf '\n// package-update-smoke-old-code\n' >>"$temporary/package-v1/agents/pi/extensions/dbz-workflows/index.ts"

fake_npm="$temporary/fake-npm"
cat >"$fake_npm" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
    view)
        python3 - "$FAKE_NPM_V2/package.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as package_file:
    print(json.dumps(json.load(package_file)["version"]))
PY
        ;;
    install)
        prefix=""
        arguments=("$@")
        for ((index = 0; index < ${#arguments[@]}; index += 1)); do
            if [ "${arguments[$index]}" = "--prefix" ]; then
                prefix="${arguments[$((index + 1))]:-}"
                break
            fi
        done
        [ -n "$prefix" ] || { printf '%s\n' 'fake npm did not receive --prefix' >&2; exit 2; }
        if [ -e "$FAKE_NPM_STATE" ]; then
            source="$FAKE_NPM_V2"
        else
            source="$FAKE_NPM_V1"
            : >"$FAKE_NPM_STATE"
        fi
        target="$prefix/node_modules/@debonzi/dbz-ai-tools"
        rm -rf "$target"
        mkdir -p "$target" "$prefix/node_modules"
        cp -a "$source/." "$target/"
        if [ ! -d "$prefix/node_modules/yaml" ]; then
            cp -a "$FAKE_NPM_RUNTIME_MODULES/yaml" "$prefix/node_modules/yaml"
        fi
        ;;
    *)
        printf 'unsupported fake npm invocation: %s\n' "$*" >&2
        exit 2
        ;;
esac
SCRIPT
chmod +x "$fake_npm"

export HOME="$temporary/home"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export FAKE_NPM_V1="$temporary/package-v1"
export FAKE_NPM_V2="$temporary/package-v2"
export FAKE_NPM_STATE="$temporary/fake-npm-state"
export FAKE_NPM_RUNTIME_MODULES="$root/node_modules"
unset PI_OFFLINE
mkdir -p "$PI_CODING_AGENT_DIR" "$temporary/workspace"
python3 - "$PI_CODING_AGENT_DIR/settings.json" "$fake_npm" <<'PY'
import json
import sys
with open(sys.argv[1], "w", encoding="utf-8") as settings_file:
    json.dump({"npmCommand": [sys.argv[2]]}, settings_file, indent=2)
    settings_file.write("\n")
PY

(
    cd "$temporary/workspace"
    pi install npm:@debonzi/dbz-ai-tools >/dev/null
)
installed="$PI_CODING_AGENT_DIR/npm/node_modules/@debonzi/dbz-ai-tools"
[ -f "$installed/skills/dbz-workflows/SKILL.md" ] || fail "the installed package is missing the DBZ Workflows skill"
[ -f "$installed/agents/pi/extensions/dbz-workflows/index.ts" ] || fail "the installed package is missing the DBZ Workflows extension"
grep -Fq 'package-update-smoke-old-code' "$installed/agents/pi/extensions/dbz-workflows/index.ts" || fail "the initial mock package was not installed"
[ "$(node -p "require('$installed/package.json').version")" = "0.0.0" ] || fail "the initial mock package has the wrong version"
(
    cd "$temporary/workspace"
    pi list
) | grep -Fq 'npm:@debonzi/dbz-ai-tools' || fail "pi list did not report the installed npm package"

plan="$(
    python3 "$installed/skills/dbz-ai-tools-setup/scripts/configure.py" plan \
        --scope global \
        --skill dbz-workflows
)"
digest="$(printf '%s' "$plan" | python3 -c 'import json, sys; print(json.load(sys.stdin)["before_sha256"])')"
python3 "$installed/skills/dbz-ai-tools-setup/scripts/configure.py" apply \
    --scope global \
    --skill dbz-workflows \
    --expected-sha256 "$digest" >/dev/null

python3 - "$PI_CODING_AGENT_DIR/settings.json" "$installed/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as settings_file:
    settings = json.load(settings_file)
package = settings["packages"][0]
assert package["skills"] == [
    "skills/dbz-ai-tools-setup/SKILL.md",
    "skills/dbz-workflows/SKILL.md",
]
assert package["extensions"] == [
    "agents/pi/extensions/dbz-workflows/index.ts",
]
with open(sys.argv[2], encoding="utf-8") as package_file:
    manifest = json.load(package_file)
assert "./skills" in manifest["pi"]["skills"]
assert "./agents/pi/extensions/dbz-workflows/index.ts" in manifest["pi"]["extensions"]
assert "agents/pi/extensions/dbz-crew-events/index.ts" not in package["extensions"]
PY

make_repository() {
    local path="$1"
    local identity="$2"
    git init --quiet --initial-branch=main "$path"
    git -C "$path" config user.name 'DBZ Package Smoke Test'
    git -C "$path" config user.email 'package-smoke@example.invalid'
    printf '%s\n' "$identity" >"$path/identity.txt"
    git -C "$path" add identity.txt
    git -C "$path" commit --quiet -m "initial $identity fixture"
}

apply_workflow_setup() {
    local cli="$1"
    local project="$2"
    local mode="$3"
    local plan_file="$temporary/${mode}-setup-plan.json"
    shift 3
    node "$cli" setup plan --mode "$mode" --project "$project" "$@" >"$plan_file"
    local plan_digest
    plan_digest="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["plan_digest"])' "$plan_file")"
    node "$cli" setup apply \
        --plan-file "$plan_file" \
        --plan-digest "$plan_digest" \
        --authorize \
        --project "$project" >/dev/null
}

managed_project="$temporary/managed-project"
project_project="$temporary/project-project"
external_project="$temporary/external-project"
external_storage="$temporary/external-workflow-state"
make_repository "$managed_project" managed
make_repository "$project_project" project
make_repository "$external_project" external
old_cli="$installed/skills/dbz-workflows/scripts/dbz-workflows.mjs"
apply_workflow_setup "$old_cli" "$managed_project" managed
apply_workflow_setup "$old_cli" "$project_project" project
apply_workflow_setup "$old_cli" "$external_project" external --external-path "$external_storage"

workflow_snapshot() {
    python3 - "$@" <<'PY'
import hashlib
import os
import stat
import sys

records = []
for root_value in sys.argv[1:]:
    root = os.path.abspath(root_value)
    if not os.path.lexists(root):
        records.append(f"missing\0{root}\0".encode())
        continue
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        for name in ["", *directories, *files]:
            path = current if name == "" else os.path.join(current, name)
            info = os.lstat(path)
            relative = os.path.relpath(path, root)
            kind = "link" if stat.S_ISLNK(info.st_mode) else "dir" if stat.S_ISDIR(info.st_mode) else "file"
            payload = b""
            if kind == "file":
                with open(path, "rb") as source:
                    payload = hashlib.sha256(source.read()).digest()
            elif kind == "link":
                payload = os.readlink(path).encode()
            records.append(f"{root}\0{relative}\0{kind}\0{stat.S_IMODE(info.st_mode):o}\0".encode() + payload)
print(hashlib.sha256(b"\n".join(sorted(records))).hexdigest())
PY
}

state_paths=(
    "$HOME/.local/share/dbz-workflows"
    "$HOME/.local/state/dbz-workflows"
    "$HOME/.config/dbz-workflows"
    "$project_project/dbz-workflows"
    "$external_storage"
)
state_before="$(workflow_snapshot "${state_paths[@]}")"
settings_before="$(sha256sum "$PI_CODING_AGENT_DIR/settings.json" | awk '{print $1}')"

(
    cd "$temporary/workspace"
    pi update --extensions >/dev/null
)

[ "$(node -p "require('$installed/package.json').version")" = "0.1.0" ] || fail "pi update --extensions did not install the current package"
if grep -Fq 'package-update-smoke-old-code' "$installed/agents/pi/extensions/dbz-workflows/index.ts"; then
    fail "pi update --extensions left the old extension code installed"
fi
[ "$settings_before" = "$(sha256sum "$PI_CODING_AGENT_DIR/settings.json" | awk '{print $1}')" ] || fail "package update changed resource filters"
[ "$state_before" = "$(workflow_snapshot "${state_paths[@]}")" ] || fail "package update modified DBZ Workflows project or user state"

new_cli="$installed/skills/dbz-workflows/scripts/dbz-workflows.mjs"
node "$new_cli" setup plan --mode managed --project "$managed_project" >"$temporary/managed-noop.json"
node "$new_cli" setup plan --mode project --project "$project_project" >"$temporary/project-noop.json"
node "$new_cli" setup plan --mode external --external-path "$external_storage" --project "$external_project" >"$temporary/external-noop.json"
python3 - "$temporary/managed-noop.json" "$temporary/project-noop.json" "$temporary/external-noop.json" <<'PY'
import json
import sys
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as plan_file:
        assert json.load(plan_file)["action"] == "noop"
PY
[ "$state_before" = "$(workflow_snapshot "${state_paths[@]}")" ] || fail "post-update setup planning modified workflow state"

printf '%s\n' 'Pi package installation and update smoke test passed.'
