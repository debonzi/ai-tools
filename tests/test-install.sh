#!/usr/bin/env bash
set -euo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

assert_link() {
    local path="$1"
    local expected="$2"
    [ -L "$path" ] || fail "$path is not a symlink"
    [ "$(readlink -- "$path")" = "$expected" ] || fail "$path has an unexpected target"
}

make_fixture() {
    local root="$1"
    mkdir -p \
        "$root/configs" \
        "$root/skills/dbz-spec" \
        "$root/skills/dbz-crew" \
        "$root/agents/pi/extensions/codex-usage" \
        "$root/agents/pi/extensions/dbz-crew-events" \
        "$root/agents/pi/prompts" \
        "$root/agents/pi/themes" \
        "$root/tools/dbz-crew" \
        "$root/agents/codex/plugins/dbz-crew/scripts"
    cp "$project_root/install.sh" "$root/install.sh"
    cp "$project_root/configs/AGENTS.md" "$root/configs/AGENTS.md"
    cp "$project_root/tools/dbz-crew/dbz-crew" "$root/tools/dbz-crew/dbz-crew"
    cp "$project_root/agents/pi/APPEND_SYSTEM.md" "$root/agents/pi/APPEND_SYSTEM.md"
    printf '%s\n' '---' 'name: dbz-spec' 'description: test' '---' >"$root/skills/dbz-spec/SKILL.md"
    printf '%s\n' '---' 'name: dbz-crew' 'description: test' '---' >"$root/skills/dbz-crew/SKILL.md"
    printf 'export default function () {}\n' >"$root/agents/pi/extensions/codex-usage/index.ts"
    printf 'export default function () {}\n' >"$root/agents/pi/extensions/dbz-crew-events/index.ts"
    touch "$root/agents/pi/prompts/.gitkeep" "$root/agents/pi/themes/.gitkeep"
    chmod +x "$root/install.sh" "$root/tools/dbz-crew/dbz-crew"
}

make_fake_commands() {
    local bin="$1"
    mkdir -p "$bin"
    for name in pi python3 git; do
        cat >"$bin/$name" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
        chmod +x "$bin/$name"
    done
    cat >"$bin/herdr" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-} ${3:-}" in
    "agent start --help")
        printf 'possible values: pi, codex\n'
        ;;
    "integration install --help")
        printf 'possible values: pi, codex\n'
        ;;
    "integration install pi")
        mkdir -p "$PI_CODING_AGENT_DIR/extensions"
        cat >"$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts" <<'INTEGRATION'
// installed by herdr
// HERDR_INTEGRATION_ID=pi
INTEGRATION
        ;;
    "integration status ")
        if [ -f "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts" ] &&
            grep -q 'HERDR_INTEGRATION_ID=pi' "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts"; then
            printf 'pi: installed (version 6)\n'
        else
            printf 'pi: not installed\n'
        fi
        ;;
    *)
        printf 'unexpected fake herdr invocation: %s\n' "$*" >&2
        exit 1
        ;;
esac
SCRIPT
    chmod +x "$bin/herdr"
}

run_installer() {
    local fixture="$1"
    local home="$2"
    local fake_bin="$3"
    HOME="$home" PI_CODING_AGENT_DIR="$home/.pi/agent" PATH="$fake_bin:/usr/bin:/bin" \
        "$fixture/install.sh" pi
}

fake_bin="$temporary/bin"
make_fake_commands "$fake_bin"

printf '%s\n' 'test: Codex packaging mirror matches the shared skill'
cmp "$project_root/skills/dbz-crew/SKILL.md" \
    "$project_root/agents/codex/plugins/dbz-crew/skills/dbz-crew/SKILL.md" || \
    fail "Codex DBZ Crew skill mirror is out of sync"

printf '%s\n' 'test: fresh install preserves unrelated resources'
fresh_fixture="$temporary/fresh-repo"
fresh_home="$temporary/fresh-home"
make_fixture "$fresh_fixture"
mkdir -p "$fresh_home/.pi/agent/extensions"
printf 'third party\n' >"$fresh_home/.pi/agent/extensions/third-party.ts"
run_installer "$fresh_fixture" "$fresh_home" "$fake_bin" >/dev/null
agent="$fresh_home/.pi/agent"
[ -d "$agent/extensions" ] && [ ! -L "$agent/extensions" ] || fail "extensions is not a real directory"
[ -f "$agent/extensions/third-party.ts" ] || fail "third-party extension was removed"
assert_link "$agent/extensions/codex-usage" "$fresh_fixture/agents/pi/extensions/codex-usage"
assert_link "$agent/extensions/dbz-crew-events" "$fresh_fixture/agents/pi/extensions/dbz-crew-events"
assert_link "$agent/skills/dbz-crew" "$fresh_fixture/skills/dbz-crew"
assert_link "$fresh_home/.local/bin/dbz-crew" "$fresh_fixture/tools/dbz-crew/dbz-crew"
[ -f "$agent/extensions/herdr-agent-state.ts" ] || fail "Herdr integration was not installed"
[ ! -e "$agent/settings.json" ] || fail "fresh install unexpectedly created settings.json"

printf '%s\n' 'test: real Pi settings remain untouched'
settings_fixture="$temporary/settings-repo"
settings_home="$temporary/settings-home"
make_fixture "$settings_fixture"
mkdir -p "$settings_home/.pi/agent"
printf '{"userOwned":true}\n' >"$settings_home/.pi/agent/settings.json"
run_installer "$settings_fixture" "$settings_home" "$fake_bin" >/dev/null
grep -q '"userOwned":true' "$settings_home/.pi/agent/settings.json" || fail "real settings were modified"

printf '%s\n' 'test: legacy directory and settings symlinks migrate safely'
legacy_fixture="$temporary/legacy-repo"
legacy_home="$temporary/legacy-home"
make_fixture "$legacy_fixture"
printf '{"theme":"dark","custom":true}\n' >"$legacy_fixture/agents/pi/settings.json"
mkdir -p "$legacy_home/.pi/agent" "$legacy_home/.local/bin"
ln -s "$legacy_fixture/agents/pi/extensions" "$legacy_home/.pi/agent/extensions"
ln -s "$legacy_fixture/skills" "$legacy_home/.pi/agent/skills"
ln -s "$legacy_fixture/agents/pi/prompts" "$legacy_home/.pi/agent/prompts"
ln -s "$legacy_fixture/agents/pi/themes" "$legacy_home/.pi/agent/themes"
ln -s "$legacy_fixture/agents/pi/settings.json" "$legacy_home/.pi/agent/settings.json"
ln -s "$legacy_fixture/agents/codex/plugins/dbz-crew/scripts/dbz-crew" "$legacy_home/.local/bin/dbz-crew"
run_installer "$legacy_fixture" "$legacy_home" "$fake_bin" >/dev/null
legacy_agent="$legacy_home/.pi/agent"
[ -d "$legacy_agent/extensions" ] && [ ! -L "$legacy_agent/extensions" ] || fail "legacy extensions link was not migrated"
[ -f "$legacy_agent/settings.json" ] && [ ! -L "$legacy_agent/settings.json" ] || fail "legacy settings link was not migrated"
grep -q '"custom":true' "$legacy_agent/settings.json" || fail "legacy settings content was not preserved"
[ "$(stat -c '%a' "$legacy_agent/settings.json")" = "600" ] || fail "migrated settings permissions are not private"
[ ! -e "$legacy_fixture/agents/pi/extensions/herdr-agent-state.ts" ] || fail "Herdr integration polluted the repository"
assert_link "$legacy_home/.local/bin/dbz-crew" "$legacy_fixture/tools/dbz-crew/dbz-crew"

printf '%s\n' 'test: unexpected collisions fail before changes'
collision_fixture="$temporary/collision-repo"
collision_home="$temporary/collision-home"
make_fixture "$collision_fixture"
mkdir -p "$collision_home/.pi/agent/extensions"
printf 'unexpected\n' >"$collision_home/.pi/agent/extensions/codex-usage"
if run_installer "$collision_fixture" "$collision_home" "$fake_bin" >/dev/null 2>&1; then
    fail "installer accepted an unexpected resource collision"
fi
[ ! -e "$collision_home/.pi/agent/skills" ] || fail "installer changed resources after failed validation"
[ ! -e "$collision_home/.pi/agent/extensions/herdr-agent-state.ts" ] || fail "installer configured Herdr after failed validation"

printf '%s\n' 'test: repository-local Herdr integration is rejected'
contaminated_fixture="$temporary/contaminated-repo"
contaminated_home="$temporary/contaminated-home"
make_fixture "$contaminated_fixture"
printf '%s\n' '// HERDR_INTEGRATION_ID=pi' >"$contaminated_fixture/agents/pi/extensions/herdr-agent-state.ts"
if run_installer "$contaminated_fixture" "$contaminated_home" "$fake_bin" >/dev/null 2>&1; then
    fail "installer accepted a repository-local Herdr integration"
fi
[ ! -e "$contaminated_home/.pi/agent/extensions" ] || fail "installer changed resources after repository contamination"

printf '%s\n' 'test: broken legacy settings symlink fails before changes'
broken_fixture="$temporary/broken-repo"
broken_home="$temporary/broken-home"
make_fixture "$broken_fixture"
mkdir -p "$broken_home/.pi/agent"
ln -s "$broken_fixture/agents/pi/settings.json" "$broken_home/.pi/agent/settings.json"
if run_installer "$broken_fixture" "$broken_home" "$fake_bin" >/dev/null 2>&1; then
    fail "installer accepted a broken legacy settings symlink"
fi
[ ! -e "$broken_home/.pi/agent/extensions" ] || fail "installer changed resources after broken settings validation"

printf '%s\n' 'All installer tests passed.'
