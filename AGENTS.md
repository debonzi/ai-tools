# Repository Instructions

- Write all documentation, user-facing text, and normative comments in English.
- Keep portable skills under `skills/` and agent-specific resources under `agents/<agent>/`.
- Unless explicitly scoped to an existing publishable package, place new Pi extensions under `agents/pi/extensions/<name>/` for repository-local development and incubation.
- Move an extension to `packages/<package>/agents/pi/extensions/<name>/` only after an explicit decision to distribute it as part of that package. Stability alone does not imply promotion.
- Never commit credentials, tokens, sessions, histories, caches, trust decisions, or machine-generated state.
- Keep agent-specific integrations cohesive; do not claim cross-agent compatibility without verification.
- Treat `GLOSSARY.md` as the canonical source for project terminology. Read it before planning or modifying repository components, and update it when introducing or changing project-specific terms.
- Use Conventional Commits, for example `feat(pi): add a prompt template`.
- Communicate with me in ptBR unless told otherwise

