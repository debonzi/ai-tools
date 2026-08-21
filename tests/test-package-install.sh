#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

run_package_test() {
    local selector="$1"
    local npm_name="$2"
    local workspace="$root/packages/$selector"
    local case_root="$temporary/$selector"
    local archive_dir="$case_root/archive"
    local unpacked_dir="$case_root/unpacked"
    local home="$case_root/home"
    local agent_dir="$case_root/agent"
    local work_dir="$case_root/work"
    local pack_json="$case_root/pack.json"
    local expected_version archive_name archive package_root

    expected_version="$(node -p "require('$workspace/package.json').version")"

    printf 'test: install and discover %s\n' "$npm_name"
    mkdir -p "$archive_dir" "$unpacked_dir" "$home" "$agent_dir" "$work_dir"
    chmod 700 "$home" "$agent_dir"

    npm pack --json --ignore-scripts --pack-destination "$archive_dir" "$workspace" >"$pack_json"
    archive_name="$(python3 - "$pack_json" "$npm_name" <<'PY'
import json
from pathlib import Path
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
name = sys.argv[2]
candidates = payload if isinstance(payload, list) else list(payload.values())
matches = [entry for entry in candidates if isinstance(entry, dict) and entry.get("name") == name]
assert len(matches) == 1, payload
print(matches[0]["filename"])
PY
)"
    archive="$archive_dir/$archive_name"
    test -f "$archive"
    tar -xzf "$archive" -C "$unpacked_dir"
    package_root="$unpacked_dir/package"
    test -f "$package_root/package.json"

    (
        export HOME="$home"
        export XDG_CONFIG_HOME="$case_root/config"
        export XDG_STATE_HOME="$case_root/state"
        export PI_CODING_AGENT_DIR="$agent_dir"
        export PI_CODING_AGENT_SESSION_DIR="$case_root/sessions"
        export PI_OFFLINE=1
        export GIT_TERMINAL_PROMPT=0
        cd "$work_dir"

        pi install "$package_root" >/dev/null
        pi list --no-approve >"$case_root/pi-list.txt"
        grep -Fq "$package_root" "$case_root/pi-list.txt"

        printf '%s\n' '{"type":"get_commands"}' | \
            pi --mode rpc --no-session --no-context-files --no-approve --offline \
            >"$case_root/rpc.jsonl"
    )

    python3 - \
        "$selector" \
        "$npm_name" \
        "$expected_version" \
        "$package_root" \
        "$agent_dir/settings.json" \
        "$agent_dir/trust.json" \
        "$case_root/rpc.jsonl" \
        "$home" \
        "$case_root/pi-list.txt" \
        "$case_root/config" \
        "$case_root/state" <<'PY'
import json
from pathlib import Path
import sys

selector, expected_name, expected_version = sys.argv[1:4]
package_root = Path(sys.argv[4]).resolve()
settings_path = Path(sys.argv[5])
trust_path = Path(sys.argv[6])
rpc_path = Path(sys.argv[7])
home = Path(sys.argv[8])
pi_list_path = Path(sys.argv[9])
xdg_config_home = Path(sys.argv[10])
xdg_state_home = Path(sys.argv[11])

manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
assert manifest["name"] == expected_name
assert manifest["version"] == expected_version

settings = json.loads(settings_path.read_text(encoding="utf-8"))
assert list(settings) == ["packages"], settings
assert len(settings["packages"]) == 1, settings
source = settings["packages"][0]
assert isinstance(source, str), "Pi package filters must not be created"
installed = Path(source).expanduser()
if not installed.is_absolute():
    installed = settings_path.parent / installed
assert installed.resolve() == package_root
assert not trust_path.exists(), "package installation must not create a trust decision"

pi_list = pi_list_path.read_text(encoding="utf-8")
assert str(package_root) in pi_list, pi_list
assert "db11-crew" not in pi_list.lower(), pi_list
assert "dbz-crew" not in pi_list.lower(), pi_list

records = [json.loads(line) for line in rpc_path.read_text(encoding="utf-8").splitlines() if line]
assert not [record for record in records if record.get("type") == "extension_error"], records
responses = [
    record
    for record in records
    if record.get("type") == "response" and record.get("command") == "get_commands"
]
assert len(responses) == 1 and responses[0].get("success") is True, records
commands = responses[0]["data"]["commands"]
owned = {
    command["name"]: command
    for command in commands
    if command.get("sourceInfo", {}).get("origin") == "package"
    and Path(command["sourceInfo"].get("baseDir", "")).resolve() == package_root
}

if selector == "db11-skills":
    assert manifest["pi"] == {"skills": ["./skills"]}
    assert set(owned) == {
        "skill:db11-plan",
        "skill:db11-shipit",
        "skill:db11-journey",
    }, owned
    assert all(command["source"] == "skill" for command in owned.values())
elif selector == "pi-codex-usage":
    assert manifest["pi"] == {
        "extensions": ["./agents/pi/extensions/codex-usage/index.ts"],
    }
    assert set(owned) == {"usage-codex"}, owned
    assert owned["usage-codex"]["source"] == "extension"
elif selector == "pi-copilot-usage":
    assert manifest["pi"] == {
        "extensions": ["./agents/pi/extensions/copilot-usage/index.ts"],
    }
    assert set(owned) == {"usage-copilot"}, owned
    assert owned["usage-copilot"]["source"] == "extension"
else:
    raise AssertionError(selector)

command_names = {command["name"] for command in commands}
prohibited_commands = {
    "skill:db11-issues",
    "skill:db11-spec",
    "skill:dbz-crew",
    "skill:dbz-crew-setup",
    "skill:dbz-ai-tools-setup",
    "skill:dbz-issues",
    "skill:dbz-spec",
}
prohibited_commands |= {"skill:db11-crew", "skill:db11-crew-setup"}
assert prohibited_commands.isdisjoint(command_names), command_names
assert "cusage" not in command_names
PY
}

requested="${1:-all}"
case "$requested" in
    all)
        run_package_test db11-skills @debonzi/db11-skills
        run_package_test pi-codex-usage @debonzi/pi-codex-usage
        run_package_test pi-copilot-usage @debonzi/pi-copilot-usage
        ;;
    db11-skills)
        run_package_test db11-skills @debonzi/db11-skills
        ;;
    pi-codex-usage)
        run_package_test pi-codex-usage @debonzi/pi-codex-usage
        ;;
    pi-copilot-usage)
        run_package_test pi-copilot-usage @debonzi/pi-copilot-usage
        ;;
    *)
        printf 'Unknown package selector: %s\n' "$requested" >&2
        exit 2
        ;;
esac

printf '%s\n' 'Selected isolated Pi package installation tests passed.'
