local wezterm = require 'wezterm'
local act = wezterm.action

local config = wezterm.config_builder()

config.window_decorations = "RESIZE"
config.enable_tab_bar = false
config.window_background_opacity = 0.88
config.use_ime = false
-- config.default_prog = { 'bash', '-lc', [[
-- set -euo pipefail
--
-- socket_name="${WEZTERM_UNIX_SOCKET##*/}"
-- window_id=""
--
-- if [ -n "${WEZTERM_PANE:-}" ]; then
--   for _ in 1 2 3 4 5; do
--     window_id="$(
--       wezterm cli list --format table 2>/dev/null |
--         awk -v pane="$WEZTERM_PANE" 'NR > 1 && $3 == pane { print $1; exit }'
--     )"
--
--     [ -n "$window_id" ] && break
--     sleep 0.05
--   done
-- fi
--
-- ident="${socket_name:-nosocket}-win-${window_id:-pane-${WEZTERM_PANE:-$$}}"
-- ident="$(printf '%s' "$ident" | sed -E 's/[^[:alnum:]_.-]+/-/g; s/^-+//; s/-+$//')"
--
-- exec tmux new-session -A -s "wezterm-${ident:-$$}" -n main
-- ]] }
config.colors = {
  background = '#101827',
}

config.keys = {
  { key = 'F11', mods = 'NONE', action = act.ToggleFullScreen },
  { key = 'Enter', mods = 'ALT', action = act.DisableDefaultAssignment },
}

return config
