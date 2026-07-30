#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/bin"

usage() {
    printf 'usage: %s <codex|pi>\n' "$0"
}

require_command() {
    local command_name="$1"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        printf 'error: required command not found: %s\n' "$command_name" >&2
        validation_failed=1
    fi
}

validate_link() {
    local source="$1"
    local target="$2"

    if [ ! -e "$source" ]; then
        printf 'error: source not found: %s\n' "$source" >&2
        validation_failed=1
        return
    fi

    if [ -L "$target" ]; then
        local current_target
        current_target="$(readlink -- "$target")"
        if [ "$current_target" != "$source" ]; then
            printf 'error: %s points to %s; expected %s\n' "$target" "$current_target" "$source" >&2
            validation_failed=1
        fi
    elif [ -e "$target" ]; then
        printf 'error: %s already exists and is not the expected symlink\n' "$target" >&2
        validation_failed=1
    fi
}

install_link() {
    local source="$1"
    local target="$2"

    if [ -L "$target" ]; then
        printf '%s already installed -> %s\n' "$target" "$source"
        return
    fi

    ln -s "$source" "$target"
    printf '%s -> %s\n' "$target" "$source"
}

install_codex() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"
    local crew="$repo_root/agents/codex/plugins/dbz-crew/scripts/dbz-crew"
    local shared_agents="$repo_root/configs/AGENTS.md"
    local spec_skill="$repo_root/skills/dbz-spec"

    validation_failed=0
    for command_name in codex python3 git herdr; do
        require_command "$command_name"
    done

    validate_link "$shared_agents" "$codex_home/AGENTS.md"
    validate_link "$spec_skill" "$codex_home/skills/dbz-spec"
    validate_link "$crew" "$bin_dir/dbz-crew"

    if [ "$validation_failed" -ne 0 ]; then
        printf 'no changes made\n' >&2
        exit 1
    fi

    mkdir -p "$codex_home/skills" "$bin_dir"
    "$crew" install

    install_link "$shared_agents" "$codex_home/AGENTS.md"
    install_link "$spec_skill" "$codex_home/skills/dbz-spec"
    install_link "$crew" "$bin_dir/dbz-crew"
}

install_pi() {
    local pi_dir="$repo_root/agents/pi"
    local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    local shared_agents="$repo_root/configs/AGENTS.md"
    local optional_entries=(keybindings.json models.json SYSTEM.md APPEND_SYSTEM.md)

    validation_failed=0
    require_command pi

    validate_link "$shared_agents" "$agent_dir/AGENTS.md"
    validate_link "$pi_dir/settings.json" "$agent_dir/settings.json"
    validate_link "$repo_root/skills" "$agent_dir/skills"
    validate_link "$pi_dir/extensions" "$agent_dir/extensions"
    validate_link "$pi_dir/prompts" "$agent_dir/prompts"
    validate_link "$pi_dir/themes" "$agent_dir/themes"

    local entry
    for entry in "${optional_entries[@]}"; do
        if [ -e "$pi_dir/$entry" ]; then
            validate_link "$pi_dir/$entry" "$agent_dir/$entry"
        fi
    done

    if [ "$validation_failed" -ne 0 ]; then
        printf 'no changes made\n' >&2
        exit 1
    fi

    mkdir -p "$agent_dir"
    install_link "$shared_agents" "$agent_dir/AGENTS.md"
    install_link "$pi_dir/settings.json" "$agent_dir/settings.json"
    install_link "$repo_root/skills" "$agent_dir/skills"
    install_link "$pi_dir/extensions" "$agent_dir/extensions"
    install_link "$pi_dir/prompts" "$agent_dir/prompts"
    install_link "$pi_dir/themes" "$agent_dir/themes"

    for entry in "${optional_entries[@]}"; do
        if [ -e "$pi_dir/$entry" ]; then
            install_link "$pi_dir/$entry" "$agent_dir/$entry"
        fi
    done
}

if [ "$#" -ne 1 ]; then
    usage >&2
    exit 2
fi

case "$1" in
    codex)
        install_codex
        ;;
    pi)
        install_pi
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
