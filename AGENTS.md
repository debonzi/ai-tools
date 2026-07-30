# Repository Instructions

- Write all documentation, user-facing text, and normative comments in English.
- Keep portable skills under `skills/` and agent-specific resources under `agents/<agent>/`.
- Keep shared global agent instructions under `configs/`.
- Never commit credentials, tokens, sessions, histories, caches, trust decisions, or machine-generated state.
- Validate every prerequisite and destination before an installer makes changes.
- Installation scripts must never overwrite unexpected user files or symlinks.
- Keep agent-specific integrations cohesive; do not claim cross-agent compatibility without verification.
- Use Conventional Commits, for example `feat(pi): add a prompt template`.
