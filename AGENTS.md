# Repository Instructions

- Write all documentation, user-facing text, and normative comments in English.
- The repository root is the Git-distributed Pi package. Keep distributed extensions under `extensions/<name>/index.ts` and tests under `tests/`.
- Keep experiments outside Pi discovery directories. Adding a resource under `extensions/`, `skills/`, `prompts/`, or `themes/` opts it into the distributed package.
- Do not add a root `package.json` or assume an npm install step for users. Use only runtime dependencies supplied by Pi or Node, or explicitly revisit the Git-only installation contract.
- Never commit credentials, tokens, sessions, histories, caches, trust decisions, or machine-generated state.
- Keep agent-specific integrations cohesive; do not claim cross-agent compatibility without verification.
- Treat `GLOSSARY.md` as the canonical source for project terminology. Read it before planning or modifying repository components, and update it when introducing or changing project-specific terms.
- Use Conventional Commits, for example `feat(pi): add a prompt template`.
- Communicate with me in ptBR unless told otherwise

