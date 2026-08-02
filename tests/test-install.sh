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
        "$root/configs/herdr" \
        "$root/configs/starship" \
        "$root/configs/wezterm" \
        "$root/skills/dbz-spec" \
        "$root/skills/dbz-crew" \
        "$root/skills/dbz-issues/scripts" \
        "$root/agents/pi/extensions/codex-usage" \
        "$root/agents/pi/extensions/dbz-crew-events" \
        "$root/agents/pi/prompts" \
        "$root/agents/pi/themes" \
        "$root/tools/dbz-crew"
    cp "$project_root/install.sh" "$root/install.sh"
    cp "$project_root/configs/AGENTS.md" "$root/configs/AGENTS.md"
    cp "$project_root/configs/herdr/config.toml" "$root/configs/herdr/config.toml"
    cp "$project_root/configs/starship/starship.toml" "$root/configs/starship/starship.toml"
    cp "$project_root/configs/wezterm/wezterm.lua" "$root/configs/wezterm/wezterm.lua"
    cp "$project_root/tools/dbz-crew/dbz-crew" "$root/tools/dbz-crew/dbz-crew"
    cp "$project_root/agents/pi/APPEND_SYSTEM.md" "$root/agents/pi/APPEND_SYSTEM.md"
    printf '%s\n' '---' 'name: dbz-spec' 'description: test' '---' >"$root/skills/dbz-spec/SKILL.md"
    printf '%s\n' '---' 'name: dbz-crew' 'description: test' '---' >"$root/skills/dbz-crew/SKILL.md"
    printf '%s\n' '---' 'name: dbz-issues' 'description: test' '---' >"$root/skills/dbz-issues/SKILL.md"
    printf '%s\n' '#!/usr/bin/env python3' >"$root/skills/dbz-issues/scripts/issues.py"
    printf 'export default function () {}\n' >"$root/agents/pi/extensions/codex-usage/index.ts"
    printf 'export default function () {}\n' >"$root/agents/pi/extensions/dbz-crew-events/index.ts"
    touch "$root/agents/pi/prompts/.gitkeep" "$root/agents/pi/themes/.gitkeep"
    chmod +x "$root/install.sh" "$root/tools/dbz-crew/dbz-crew" "$root/skills/dbz-issues/scripts/issues.py"
}

make_fake_commands() {
    local bin="$1"
    mkdir -p "$bin"
    for name in pi python3 git zsh; do
        cat >"$bin/$name" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
        chmod +x "$bin/$name"
    done
    cat >"$bin/uname" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_UNAME:-Linux}"
SCRIPT
    chmod +x "$bin/uname"
    cat >"$bin/starship" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${FAKE_STARSHIP_CONFIG_FAIL:-0}" = "1" ]; then
    exit 1
fi
if [ "${1:-}" != "print-config" ] || [ ! -f "${STARSHIP_CONFIG:-}" ]; then
    printf 'unexpected fake starship invocation: %s\n' "$*" >&2
    exit 1
fi
SCRIPT
    chmod +x "$bin/starship"
    cat >"$bin/wezterm" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" != "--config-file" ] || [ ! -f "${2:-}" ] || [ "${3:-}" != "show-keys" ]; then
    printf 'unexpected fake wezterm invocation: %s\n' "$*" >&2
    exit 1
fi
SCRIPT
    chmod +x "$bin/wezterm"
    cat >"$bin/herdr" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-} ${3:-}" in
    "config check ")
        [ -f "${HERDR_CONFIG_PATH:-}" ] || exit 1
        ;;
    "agent start --help")
        printf 'possible values: pi\n'
        ;;
    "integration install --help")
        printf 'possible values: pi\n'
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
            printf 'pi: current (v6) (/tmp/test-pi/extensions/herdr-agent-state.ts)\n'
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

run_config_installer() {
    local fixture="$1"
    local home="$2"
    local fake_bin="$3"
    HOME="$home" XDG_CONFIG_HOME="$home/.config" PATH="$fake_bin:/usr/bin:/bin" \
        "$fixture/install.sh" configs
}

fake_bin="$temporary/bin"
make_fake_commands "$fake_bin"

printf '%s\n' 'test: Codex installation target is unsupported'
unsupported_fixture="$temporary/unsupported-repo"
unsupported_home="$temporary/unsupported-home"
make_fixture "$unsupported_fixture"
if HOME="$unsupported_home" PATH="$fake_bin:/usr/bin:/bin" \
    "$unsupported_fixture/install.sh" codex >/dev/null 2>&1; then
    fail "installer accepted the removed Codex target"
fi
[ ! -e "$unsupported_home/.codex" ] || fail "unsupported target created a Codex home"

printf '%s\n' 'test: fresh config install creates links and is idempotent'
config_fixture="$temporary/config-fresh/dbz-ai-tools"
config_home="$temporary/config-fresh/home"
make_fixture "$config_fixture"
first_config_output="$(run_config_installer "$config_fixture" "$config_home" "$fake_bin")"
assert_link "$config_home/.config/wezterm/wezterm.lua" "$config_fixture/configs/wezterm/wezterm.lua"
assert_link "$config_home/.config/starship.toml" "$config_fixture/configs/starship/starship.toml"
assert_link "$config_home/.config/herdr/config.toml" "$config_fixture/configs/herdr/config.toml"
printf '%s\n' "$first_config_output" | grep -Fq "$config_home/.config/starship.toml ->" || \
    fail "fresh config install did not report the Starship link"
second_config_output="$(run_config_installer "$config_fixture" "$config_home" "$fake_bin")"
printf '%s\n' "$second_config_output" | grep -Fq 'already installed' || \
    fail "repeated config install did not report idempotent links"

printf '%s\n' 'test: recognized legacy config links migrate automatically'
legacy_config_case="$temporary/config-legacy"
legacy_config_fixture="$legacy_config_case/dbz-ai-tools"
legacy_config_root="$legacy_config_case/dbz-toolbox"
legacy_config_home="$legacy_config_case/home"
make_fixture "$legacy_config_fixture"
mkdir -p \
    "$legacy_config_root/devtools/dotfiles/.config/wezterm" \
    "$legacy_config_root/devtools/dotfiles/.config/herdr" \
    "$legacy_config_home/.config/wezterm" \
    "$legacy_config_home/.config/herdr"
touch \
    "$legacy_config_root/devtools/dotfiles/.config/wezterm/wezterm.lua" \
    "$legacy_config_root/devtools/dotfiles/.config/starship.toml" \
    "$legacy_config_root/devtools/dotfiles/.config/herdr/config.toml"
ln -s "$legacy_config_root/devtools/dotfiles/.config/wezterm/wezterm.lua" \
    "$legacy_config_home/.config/wezterm/wezterm.lua"
ln -s "$legacy_config_root/devtools/dotfiles/.config/starship.toml" \
    "$legacy_config_home/.config/starship.toml"
ln -s "$legacy_config_root/devtools/dotfiles/.config/herdr/config.toml" \
    "$legacy_config_home/.config/herdr/config.toml"
run_config_installer "$legacy_config_fixture" "$legacy_config_home" "$fake_bin" >/dev/null
assert_link "$legacy_config_home/.config/wezterm/wezterm.lua" \
    "$legacy_config_fixture/configs/wezterm/wezterm.lua"
assert_link "$legacy_config_home/.config/starship.toml" \
    "$legacy_config_fixture/configs/starship/starship.toml"
assert_link "$legacy_config_home/.config/herdr/config.toml" \
    "$legacy_config_fixture/configs/herdr/config.toml"

printf '%s\n' 'test: unexpected config collision fails before changes'
collision_config_case="$temporary/config-collision"
collision_config_fixture="$collision_config_case/dbz-ai-tools"
collision_config_root="$collision_config_case/dbz-toolbox"
collision_config_home="$collision_config_case/home"
make_fixture "$collision_config_fixture"
mkdir -p \
    "$collision_config_root/devtools/dotfiles/.config/wezterm" \
    "$collision_config_home/.config/wezterm"
touch "$collision_config_root/devtools/dotfiles/.config/wezterm/wezterm.lua"
legacy_wezterm_link="$collision_config_root/devtools/dotfiles/.config/wezterm/wezterm.lua"
ln -s "$legacy_wezterm_link" "$collision_config_home/.config/wezterm/wezterm.lua"
printf '%s\n' 'user-owned' >"$collision_config_home/.config/starship.toml"
if run_config_installer "$collision_config_fixture" "$collision_config_home" "$fake_bin" >/dev/null 2>&1; then
    fail "config installer accepted an unexpected collision"
fi
assert_link "$collision_config_home/.config/wezterm/wezterm.lua" "$legacy_wezterm_link"
[ ! -e "$collision_config_home/.config/herdr" ] || \
    fail "config installer changed another destination after failed validation"

printf '%s\n' 'test: missing config source fails before changes'
missing_config_fixture="$temporary/config-missing/dbz-ai-tools"
missing_config_home="$temporary/config-missing/home"
make_fixture "$missing_config_fixture"
rm "$missing_config_fixture/configs/herdr/config.toml"
if run_config_installer "$missing_config_fixture" "$missing_config_home" "$fake_bin" >/dev/null 2>&1; then
    fail "config installer accepted a missing source"
fi
[ ! -e "$missing_config_home/.config" ] || \
    fail "config installer created destinations after missing-source validation"

printf '%s\n' 'test: invalid config content fails before changes'
invalid_config_fixture="$temporary/config-invalid/dbz-ai-tools"
invalid_config_home="$temporary/config-invalid/home"
make_fixture "$invalid_config_fixture"
if FAKE_STARSHIP_CONFIG_FAIL=1 run_config_installer \
    "$invalid_config_fixture" "$invalid_config_home" "$fake_bin" >/dev/null 2>&1; then
    fail "config installer accepted invalid Starship configuration"
fi
[ ! -e "$invalid_config_home/.config" ] || \
    fail "config installer created destinations after content validation failed"

printf '%s\n' 'test: linked config directory fails before changes'
linked_config_fixture="$temporary/config-linked-directory/dbz-ai-tools"
linked_config_home="$temporary/config-linked-directory/home"
linked_config_redirect="$temporary/config-linked-directory/redirect"
make_fixture "$linked_config_fixture"
mkdir -p "$linked_config_home" "$linked_config_redirect"
ln -s "$linked_config_redirect" "$linked_config_home/.config"
if run_config_installer "$linked_config_fixture" "$linked_config_home" "$fake_bin" >/dev/null 2>&1; then
    fail "config installer accepted a linked configuration directory"
fi
[ ! -e "$linked_config_redirect/starship.toml" ] || \
    fail "config installer wrote through a linked configuration directory"

printf '%s\n' 'test: config install rejects non-Linux systems before changes'
non_linux_fixture="$temporary/config-non-linux/dbz-ai-tools"
non_linux_home="$temporary/config-non-linux/home"
make_fixture "$non_linux_fixture"
if FAKE_UNAME=Darwin run_config_installer "$non_linux_fixture" "$non_linux_home" "$fake_bin" >/dev/null 2>&1; then
    fail "config installer accepted a non-Linux system"
fi
[ ! -e "$non_linux_home/.config" ] || \
    fail "config installer created destinations on a non-Linux system"

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
assert_link "$agent/skills/dbz-issues" "$fresh_fixture/skills/dbz-issues"
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
