#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validation_failed=0

usage() {
    printf 'usage: %s configs\n' "$0"
}

fail_validation() {
    printf 'error: %s\n' "$1" >&2
    validation_failed=1
}

require_command() {
    local command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        fail_validation "required command not found: $command_name"
    fi
}

validate_directory() {
    local path="$1"

    if [ -L "$path" ]; then
        fail_validation "$path is a symlink; expected a real directory or no path"
    elif [ -e "$path" ] && [ ! -d "$path" ]; then
        fail_validation "$path exists and is not a directory"
    fi
}

validate_source() {
    local source="$1"

    if [ -L "$source" ]; then
        fail_validation "$source is a symlink; expected a repository-owned regular file"
    elif [ ! -f "$source" ]; then
        fail_validation "configuration source not found: $source"
    fi
}

validate_link() {
    local source="$1"
    local target="$2"
    local legacy_source="${3:-}"

    if [ -L "$target" ]; then
        local current_target
        current_target="$(readlink -- "$target")"
        if [ "$current_target" != "$source" ] && { [ -z "$legacy_source" ] || [ "$current_target" != "$legacy_source" ]; }; then
            fail_validation "$target points to $current_target; expected $source"
        fi
    elif [ -e "$target" ]; then
        fail_validation "$target already exists and is not the expected symlink"
    fi
}

install_link() {
    local source="$1"
    local target="$2"
    local legacy_source="${3:-}"

    if [ -L "$target" ]; then
        local current_target
        current_target="$(readlink -- "$target")"
        if [ "$current_target" = "$source" ]; then
            printf '%s already installed -> %s\n' "$target" "$source"
            return
        fi
        if [ -z "$legacy_source" ] || [ "$current_target" != "$legacy_source" ]; then
            printf 'error: %s changed after validation and points to %s\n' "$target" "$current_target" >&2
            exit 1
        fi
        rm -- "$target"
    elif [ -e "$target" ]; then
        printf 'error: %s appeared after validation\n' "$target" >&2
        exit 1
    fi

    ln -s "$source" "$target"
    printf '%s -> %s\n' "$target" "$source"
}

install_configs() {
    local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    local wezterm_source="$repo_root/configs/wezterm/wezterm.lua"
    local starship_source="$repo_root/configs/starship/starship.toml"
    local herdr_source="$repo_root/configs/herdr/config.toml"
    local agents_source="$repo_root/configs/AGENTS.md"
    local append_system_source="$repo_root/agents/pi/APPEND_SYSTEM.md"
    local legacy_root="$(dirname -- "$repo_root")/dbz-toolbox"
    local wezterm_target="$config_home/wezterm/wezterm.lua"
    local starship_target="$config_home/starship.toml"
    local herdr_target="$config_home/herdr/config.toml"
    local agents_target="$agent_dir/AGENTS.md"
    local append_system_target="$agent_dir/APPEND_SYSTEM.md"
    local legacy_wezterm="$legacy_root/devtools/dotfiles/.config/wezterm/wezterm.lua"
    local legacy_starship="$legacy_root/devtools/dotfiles/.config/starship.toml"
    local legacy_herdr="$legacy_root/devtools/dotfiles/.config/herdr/config.toml"
    local command_name

    validation_failed=0
    for command_name in uname zsh wezterm starship herdr pi; do
        require_command "$command_name"
    done

    if command -v uname >/dev/null 2>&1 && [ "$(uname -s)" != "Linux" ]; then
        fail_validation "configuration installation is supported only on Linux"
    fi
    case "$config_home" in
        /*) ;;
        *) fail_validation "XDG_CONFIG_HOME must be an absolute path" ;;
    esac
    case "$agent_dir" in
        /*) ;;
        *) fail_validation "PI_CODING_AGENT_DIR must be an absolute path" ;;
    esac

    validate_source "$wezterm_source"
    validate_source "$starship_source"
    validate_source "$herdr_source"
    validate_source "$agents_source"
    validate_source "$append_system_source"
    validate_directory "$config_home"
    validate_directory "$config_home/wezterm"
    validate_directory "$config_home/herdr"
    validate_directory "$(dirname -- "$agent_dir")"
    validate_directory "$agent_dir"
    validate_link "$wezterm_source" "$wezterm_target" "$legacy_wezterm"
    validate_link "$starship_source" "$starship_target" "$legacy_starship"
    validate_link "$herdr_source" "$herdr_target" "$legacy_herdr"
    validate_link "$agents_source" "$agents_target"
    validate_link "$append_system_source" "$append_system_target"

    if [ "$validation_failed" -eq 0 ]; then
        if ! HERDR_CONFIG_PATH="$herdr_source" herdr config check >/dev/null 2>&1; then
            fail_validation "Herdr configuration is invalid: $herdr_source"
        fi
        if ! STARSHIP_CONFIG="$starship_source" starship print-config >/dev/null 2>&1; then
            fail_validation "Starship configuration is invalid: $starship_source"
        fi
        if ! wezterm --config-file "$wezterm_source" show-keys >/dev/null 2>&1; then
            fail_validation "WezTerm configuration is invalid: $wezterm_source"
        fi
    fi

    if [ "$validation_failed" -ne 0 ]; then
        printf 'no changes made\n' >&2
        exit 1
    fi

    mkdir -p "$config_home/wezterm" "$config_home/herdr" "$agent_dir"
    install_link "$wezterm_source" "$wezterm_target" "$legacy_wezterm"
    install_link "$starship_source" "$starship_target" "$legacy_starship"
    install_link "$herdr_source" "$herdr_target" "$legacy_herdr"
    install_link "$agents_source" "$agents_target"
    install_link "$append_system_source" "$append_system_target"
}

if [ "$#" -ne 1 ]; then
    usage >&2
    exit 2
fi

case "$1" in
    configs)
        install_configs
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
