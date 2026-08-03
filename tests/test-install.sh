#!/usr/bin/env bash
set -euo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

make_fixture() {
    local root="$1"
    mkdir -p \
        "$root/configs/wezterm" \
        "$root/configs/starship" \
        "$root/configs/herdr" \
        "$root/agents/pi"
    cp "$project_root/install.sh" "$root/install.sh"
    cp "$project_root/configs/wezterm/wezterm.lua" "$root/configs/wezterm/wezterm.lua"
    cp "$project_root/configs/starship/starship.toml" "$root/configs/starship/starship.toml"
    cp "$project_root/configs/herdr/config.toml" "$root/configs/herdr/config.toml"
    cp "$project_root/configs/AGENTS.md" "$root/configs/AGENTS.md"
    cp "$project_root/agents/pi/APPEND_SYSTEM.md" "$root/agents/pi/APPEND_SYSTEM.md"
    chmod +x "$root/install.sh"
}

make_fake_commands() {
    local bin="$1"
    mkdir -p "$bin"
    for name in zsh pi; do
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
    cat >"$bin/starship" <<'SCRIPT'
#!/usr/bin/env bash
[ "${FAKE_STARSHIP_CONFIG_FAIL:-0}" != 1 ]
SCRIPT
    cat >"$bin/wezterm" <<'SCRIPT'
#!/usr/bin/env bash
[ "${FAKE_WEZTERM_CONFIG_FAIL:-0}" != 1 ]
SCRIPT
    cat >"$bin/herdr" <<'SCRIPT'
#!/usr/bin/env bash
case "$*" in
    "config check") [ "${FAKE_HERDR_CONFIG_FAIL:-0}" != 1 ] ;;
    *) exit 0 ;;
esac
SCRIPT
    chmod +x "$bin/uname" "$bin/starship" "$bin/wezterm" "$bin/herdr"
}

run_installer() {
    local fixture="$1"
    local home="$2"
    local fake_bin="$3"
    shift 3
    HOME="$home" XDG_CONFIG_HOME="$home/.config" \
        PI_CODING_AGENT_DIR="$home/.pi/agent" PATH="$fake_bin:/usr/bin:/bin" \
        "$fixture/install.sh" "$@"
}

assert_link() {
    local target="$1"
    local expected="$2"
    [ -L "$target" ] || fail "$target is not a symlink"
    [ "$(readlink -- "$target")" = "$expected" ] || \
        fail "$target points to $(readlink -- "$target"), expected $expected"
}

printf '%s\n' 'test: removed Pi installation target is rejected'
unsupported_fixture="$work/unsupported/repo"
unsupported_home="$work/unsupported/home"
unsupported_bin="$work/unsupported/bin"
make_fixture "$unsupported_fixture"
make_fake_commands "$unsupported_bin"
mkdir -p "$unsupported_home"
if run_installer "$unsupported_fixture" "$unsupported_home" "$unsupported_bin" pi >/dev/null 2>&1; then
    fail "installer accepted the removed Pi target"
fi
[ ! -e "$unsupported_home/.pi" ] || fail "unsupported target changed Pi state"

printf '%s\n' 'test: fresh config install creates links and is idempotent'
fresh_fixture="$work/fresh/repo"
fresh_home="$work/fresh/home"
fresh_bin="$work/fresh/bin"
make_fixture "$fresh_fixture"
make_fake_commands "$fresh_bin"
mkdir -p "$fresh_home"
first_output="$(run_installer "$fresh_fixture" "$fresh_home" "$fresh_bin" configs)"
assert_link "$fresh_home/.config/wezterm/wezterm.lua" "$fresh_fixture/configs/wezterm/wezterm.lua"
assert_link "$fresh_home/.config/starship.toml" "$fresh_fixture/configs/starship/starship.toml"
assert_link "$fresh_home/.config/herdr/config.toml" "$fresh_fixture/configs/herdr/config.toml"
assert_link "$fresh_home/.pi/agent/AGENTS.md" "$fresh_fixture/configs/AGENTS.md"
assert_link "$fresh_home/.pi/agent/APPEND_SYSTEM.md" "$fresh_fixture/agents/pi/APPEND_SYSTEM.md"
printf '%s\n' "$first_output" | grep -Fq 'APPEND_SYSTEM.md' || fail "fresh install did not report Pi instructions"
second_output="$(run_installer "$fresh_fixture" "$fresh_home" "$fresh_bin" configs)"
printf '%s\n' "$second_output" | grep -Fq 'already installed' || fail "repeated install was not idempotent"

printf '%s\n' 'test: recognized legacy work-environment links are migrated'
legacy_fixture="$work/legacy/dbz-ai-tools"
legacy_home="$work/legacy/home"
legacy_bin="$work/legacy/bin"
legacy_root="$work/legacy/dbz-toolbox"
make_fixture "$legacy_fixture"
make_fake_commands "$legacy_bin"
mkdir -p \
    "$legacy_home/.config/wezterm" \
    "$legacy_home/.config/herdr" \
    "$legacy_root/devtools/dotfiles/.config/wezterm" \
    "$legacy_root/devtools/dotfiles/.config/herdr"
printf 'return {}\n' >"$legacy_root/devtools/dotfiles/.config/wezterm/wezterm.lua"
printf 'format = ""\n' >"$legacy_root/devtools/dotfiles/.config/starship.toml"
printf 'version = 1\n' >"$legacy_root/devtools/dotfiles/.config/herdr/config.toml"
ln -s "$legacy_root/devtools/dotfiles/.config/wezterm/wezterm.lua" "$legacy_home/.config/wezterm/wezterm.lua"
ln -s "$legacy_root/devtools/dotfiles/.config/starship.toml" "$legacy_home/.config/starship.toml"
ln -s "$legacy_root/devtools/dotfiles/.config/herdr/config.toml" "$legacy_home/.config/herdr/config.toml"
run_installer "$legacy_fixture" "$legacy_home" "$legacy_bin" configs >/dev/null
assert_link "$legacy_home/.config/wezterm/wezterm.lua" "$legacy_fixture/configs/wezterm/wezterm.lua"
assert_link "$legacy_home/.config/starship.toml" "$legacy_fixture/configs/starship/starship.toml"
assert_link "$legacy_home/.config/herdr/config.toml" "$legacy_fixture/configs/herdr/config.toml"

printf '%s\n' 'test: destination collision prevents every change'
collision_fixture="$work/collision/repo"
collision_home="$work/collision/home"
collision_bin="$work/collision/bin"
make_fixture "$collision_fixture"
make_fake_commands "$collision_bin"
mkdir -p "$collision_home/.pi/agent"
printf 'preserve\n' >"$collision_home/.pi/agent/AGENTS.md"
if run_installer "$collision_fixture" "$collision_home" "$collision_bin" configs >/dev/null 2>&1; then
    fail "installer accepted an unexpected AGENTS.md collision"
fi
[ ! -e "$collision_home/.config" ] || fail "installer changed another destination after failed validation"
[ "$(cat "$collision_home/.pi/agent/AGENTS.md")" = preserve ] || fail "collision file changed"

printf '%s\n' 'test: missing source prevents every change'
missing_fixture="$work/missing/repo"
missing_home="$work/missing/home"
missing_bin="$work/missing/bin"
make_fixture "$missing_fixture"
make_fake_commands "$missing_bin"
mkdir -p "$missing_home"
rm "$missing_fixture/agents/pi/APPEND_SYSTEM.md"
if run_installer "$missing_fixture" "$missing_home" "$missing_bin" configs >/dev/null 2>&1; then
    fail "installer accepted a missing source"
fi
[ ! -e "$missing_home/.config" ] || fail "missing source caused destination changes"
[ ! -e "$missing_home/.pi" ] || fail "missing source caused Pi changes"

printf '%s\n' 'test: content validation failure prevents every change'
invalid_fixture="$work/invalid/repo"
invalid_home="$work/invalid/home"
invalid_bin="$work/invalid/bin"
make_fixture "$invalid_fixture"
make_fake_commands "$invalid_bin"
mkdir -p "$invalid_home"
if FAKE_STARSHIP_CONFIG_FAIL=1 run_installer "$invalid_fixture" "$invalid_home" "$invalid_bin" configs >/dev/null 2>&1; then
    fail "installer accepted invalid Starship configuration"
fi
[ ! -e "$invalid_home/.config" ] || fail "validation failure caused destination changes"
[ ! -e "$invalid_home/.pi" ] || fail "validation failure caused Pi changes"

printf '%s\n' 'test: linked destination directories are rejected'
linked_fixture="$work/linked/repo"
linked_home="$work/linked/home"
linked_bin="$work/linked/bin"
make_fixture "$linked_fixture"
make_fake_commands "$linked_bin"
mkdir -p "$linked_home" "$work/linked/unexpected-config" "$work/linked/unexpected-agent"
ln -s "$work/linked/unexpected-config" "$linked_home/.config"
mkdir -p "$linked_home/.pi"
ln -s "$work/linked/unexpected-agent" "$linked_home/.pi/agent"
if run_installer "$linked_fixture" "$linked_home" "$linked_bin" configs >/dev/null 2>&1; then
    fail "installer accepted linked destination directories"
fi
[ -z "$(find "$work/linked/unexpected-config" -mindepth 1 -print -quit)" ] || fail "installer wrote through config symlink"
[ -z "$(find "$work/linked/unexpected-agent" -mindepth 1 -print -quit)" ] || fail "installer wrote through agent symlink"

printf '%s\n' 'test: non-Linux systems are rejected before changes'
non_linux_fixture="$work/non-linux/repo"
non_linux_home="$work/non-linux/home"
non_linux_bin="$work/non-linux/bin"
make_fixture "$non_linux_fixture"
make_fake_commands "$non_linux_bin"
mkdir -p "$non_linux_home"
if FAKE_UNAME=Darwin run_installer "$non_linux_fixture" "$non_linux_home" "$non_linux_bin" configs >/dev/null 2>&1; then
    fail "installer accepted a non-Linux system"
fi
[ ! -e "$non_linux_home/.config" ] || fail "non-Linux validation caused changes"
[ ! -e "$non_linux_home/.pi" ] || fail "non-Linux validation caused Pi changes"

printf '%s\n' 'All installer tests passed.'
