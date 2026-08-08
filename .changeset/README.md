# Changesets

Changesets are managed from the private repository root, while package versions remain independent. The configuration intentionally keeps `fixed` and `linked` groups empty.

Run `npx changeset` for every user-visible change and select each affected package explicitly:

- `@debonzi/dbz-skills`
- `@debonzi/dbz-crew`
- `@debonzi/pi-codex-usage`

Choose the SemVer impact for each selected package and write a concise consumer-facing summary. Do not target the private workspace root. Maintainers consume pending Changesets using the procedure in [`docs/releasing.md`](../docs/releasing.md).
