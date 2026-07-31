#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/bin"
validation_failed=0

usage() {
    printf 'usage: %s <codex|pi>\n' "$0"
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

validate_parent_directory() {
    local path="$1"
    if [ -e "$path" ] && [ ! -d "$path" ]; then
        fail_validation "$path exists and is not a directory"
    fi
}

validate_link() {
    local source="$1"
    local target="$2"
    local legacy_source="${3:-}"

    if [ ! -e "$source" ]; then
        fail_validation "source not found: $source"
        return
    fi

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
        if [ -n "$legacy_source" ] && [ "$current_target" = "$legacy_source" ]; then
            rm -- "$target"
        fi
    fi

    ln -s "$source" "$target"
    printf '%s -> %s\n' "$target" "$source"
}

resource_entries() {
    local source_dir="$1"
    find "$source_dir" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -printf '%f\n' | LC_ALL=C sort
}

validate_resource_directory() {
    local source_dir="$1"
    local target_dir="$2"

    if [ ! -d "$source_dir" ]; then
        fail_validation "resource directory not found: $source_dir"
        return
    fi

    if [ -L "$target_dir" ]; then
        local current_target
        current_target="$(readlink -- "$target_dir")"
        if [ "$current_target" != "$source_dir" ]; then
            fail_validation "$target_dir points to $current_target; expected $source_dir"
        fi
        return
    fi
    if [ -e "$target_dir" ] && [ ! -d "$target_dir" ]; then
        fail_validation "$target_dir exists and is not a directory"
        return
    fi

    local entry source target
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        source="$source_dir/$entry"
        target="$target_dir/$entry"
        if [ -L "$target" ]; then
            local current_target
            current_target="$(readlink -- "$target")"
            if [ "$current_target" != "$source" ]; then
                fail_validation "$target points to $current_target; expected $source"
            fi
        elif [ -e "$target" ]; then
            fail_validation "$target already exists and is not the expected symlink"
        fi
    done < <(resource_entries "$source_dir")
}

install_resource_directory() {
    local source_dir="$1"
    local target_dir="$2"

    if [ -L "$target_dir" ]; then
        rm -- "$target_dir"
    fi
    mkdir -p "$target_dir"

    local entry
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        install_link "$source_dir/$entry" "$target_dir/$entry"
    done < <(resource_entries "$source_dir")
}

validate_settings_migration() {
    local legacy_source="$1"
    local target="$2"

    if [ -L "$target" ]; then
        local current_target
        current_target="$(readlink -- "$target")"
        if [ "$current_target" != "$legacy_source" ]; then
            fail_validation "$target points to $current_target; expected the legacy repository settings path"
        elif [ ! -r "$target" ]; then
            fail_validation "$target is a broken legacy settings symlink; replace it with a real settings.json before retrying"
        fi
    elif [ -e "$target" ] && [ ! -f "$target" ]; then
        fail_validation "$target exists and is not a regular settings file"
    fi
}

migrate_settings() {
    local legacy_source="$1"
    local target="$2"

    if [ ! -L "$target" ]; then
        return
    fi

    local temporary="$target.dbz-crew-migration.$$"
    cp --dereference --preserve=mode "$target" "$temporary"
    chmod 600 "$temporary"
    rm -- "$target"
    mv -- "$temporary" "$target"
    printf '%s migrated from repository symlink to a real file\n' "$target"
}

validate_herdr_pi_capabilities() {
    if ! herdr agent start --help 2>&1 | grep -Eq '(^|[^[:alnum:]_])pi([^[:alnum:]_]|$)'; then
        fail_validation "Herdr cannot start Pi workers"
    fi
    if ! herdr integration install --help 2>&1 | grep -Eq '(^|[^[:alnum:]_])pi([^[:alnum:]_]|$)'; then
        fail_validation "Herdr cannot install the official Pi integration"
    fi
}

validate_herdr_pi_destination() {
    local target="$1"
    if [ -L "$target" ]; then
        fail_validation "$target is a symlink; expected an official Herdr-managed file or no file"
    elif [ -e "$target" ] && ! grep -q 'HERDR_INTEGRATION_ID=pi' "$target"; then
        fail_validation "$target exists but is not managed by the official Herdr Pi integration"
    fi
}

install_codex() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"
    local crew="$repo_root/tools/dbz-crew/dbz-crew"
    local legacy_crew="$repo_root/agents/codex/plugins/dbz-crew/scripts/dbz-crew"
    local shared_agents="$repo_root/configs/AGENTS.md"
    local spec_skill="$repo_root/skills/dbz-spec"

    validation_failed=0
    for command_name in codex python3 git herdr; do
        require_command "$command_name"
    done
    validate_parent_directory "$codex_home"
    validate_parent_directory "$codex_home/skills"
    validate_parent_directory "$bin_dir"
    validate_link "$shared_agents" "$codex_home/AGENTS.md"
    validate_link "$spec_skill" "$codex_home/skills/dbz-spec"
    validate_link "$crew" "$bin_dir/dbz-crew" "$legacy_crew"

    if [ "$validation_failed" -ne 0 ]; then
        printf 'no changes made\n' >&2
        exit 1
    fi

    mkdir -p "$codex_home/skills" "$bin_dir"
    "$crew" install
    install_link "$shared_agents" "$codex_home/AGENTS.md"
    install_link "$spec_skill" "$codex_home/skills/dbz-spec"
    install_link "$crew" "$bin_dir/dbz-crew" "$legacy_crew"
}

install_pi() {
    local pi_dir="$repo_root/agents/pi"
    local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    local shared_agents="$repo_root/configs/AGENTS.md"
    local crew="$repo_root/tools/dbz-crew/dbz-crew"
    local legacy_crew="$repo_root/agents/codex/plugins/dbz-crew/scripts/dbz-crew"
    local legacy_settings="$pi_dir/settings.json"
    local optional_entries=(keybindings.json models.json SYSTEM.md APPEND_SYSTEM.md)
    local resource_names=(extensions prompts themes)

    validation_failed=0
    for command_name in pi python3 git herdr; do
        require_command "$command_name"
    done
    if command -v herdr >/dev/null 2>&1; then
        validate_herdr_pi_capabilities
    fi

    validate_parent_directory "$agent_dir"
    validate_parent_directory "$bin_dir"
    validate_link "$shared_agents" "$agent_dir/AGENTS.md"
    validate_link "$crew" "$bin_dir/dbz-crew" "$legacy_crew"
    validate_settings_migration "$legacy_settings" "$agent_dir/settings.json"
    if [ -e "$pi_dir/extensions/herdr-agent-state.ts" ] || [ -L "$pi_dir/extensions/herdr-agent-state.ts" ]; then
        fail_validation "the Herdr-managed Pi integration is inside the repository; remove it before retrying"
    fi
    validate_resource_directory "$repo_root/skills" "$agent_dir/skills"

    local resource_name
    for resource_name in "${resource_names[@]}"; do
        validate_resource_directory "$pi_dir/$resource_name" "$agent_dir/$resource_name"
    done

    local entry
    for entry in "${optional_entries[@]}"; do
        if [ -e "$pi_dir/$entry" ]; then
            validate_link "$pi_dir/$entry" "$agent_dir/$entry"
        fi
    done

    if [ -d "$agent_dir/extensions" ] && [ ! -L "$agent_dir/extensions" ]; then
        validate_herdr_pi_destination "$agent_dir/extensions/herdr-agent-state.ts"
    fi

    if [ "$validation_failed" -ne 0 ]; then
        printf 'no changes made\n' >&2
        exit 1
    fi

    mkdir -p "$agent_dir" "$bin_dir"
    migrate_settings "$legacy_settings" "$agent_dir/settings.json"
    install_link "$shared_agents" "$agent_dir/AGENTS.md"
    install_link "$crew" "$bin_dir/dbz-crew" "$legacy_crew"
    install_resource_directory "$repo_root/skills" "$agent_dir/skills"
    for resource_name in "${resource_names[@]}"; do
        install_resource_directory "$pi_dir/$resource_name" "$agent_dir/$resource_name"
    done

    for entry in "${optional_entries[@]}"; do
        if [ -e "$pi_dir/$entry" ]; then
            install_link "$pi_dir/$entry" "$agent_dir/$entry"
        fi
    done

    herdr integration install pi
    if ! herdr integration status | grep -q '^pi: installed'; then
        printf 'error: Herdr Pi integration installation could not be verified\n' >&2
        exit 1
    fi
    printf 'Herdr Pi integration installed; reload or restart active Pi sessions.\n'
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
