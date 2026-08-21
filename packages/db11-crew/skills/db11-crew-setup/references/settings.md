# Validated account settings

DB11 Crew reads one non-secret account file at `~/.config/db11-crew/config.json`. It never reads project overrides.

Use `/db11-crew-settings show` to display only validated effective configuration. Malformed, unsupported, oversized, linked, non-private, foreign-owned, or otherwise unsafe values remain hidden.

Configuration v2 contains bounded active/open/queued limits, retention policy and inspection grace, progress enablement, and optional built-in Scout, Planner, and Builder runtime choices. It rejects arbitrary roles, tools, extension paths, web-provider settings, project overrides, empty runtimes, unknown fields, and secret-like values.

Configuration v1 and unknown schemas are unsupported. There is no automatic migration or rewrite. Review `config/config.example.json`, then use `/db11-crew-settings edit` to manually prepare a v2 replacement. When the existing file is invalid, editing starts from safe defaults without reading its rejected values.

The editor validates providers and models against the current Pi model registry, reports only paths and error codes, shows the exact known-field change plan, and asks before one private atomic write. It refuses unsafe ownership, types, links, modes, and races and never repairs them. A successful write requires `/reload` or Pi restart.

Provider credentials remain in Pi/provider-owned authentication. Never put credentials in DB11 Crew settings.
