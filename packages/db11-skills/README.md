# @debonzi/db11-skills

A multi-skill Pi package for local issue management and implementation-ready specification workflows. The skills remain independently discoverable even though they share one distribution.

## Included skills

| Skill | Purpose | Prerequisites |
| --- | --- | --- |
| [`db11-issues`](skills/db11-issues/SKILL.md) | Manage dependency-aware Markdown issue registries through its bundled Python CLI | Python 3 |
| [`db11-spec`](skills/db11-spec/SKILL.md) | Guide discovery and produce an implementation-ready specification | No external executable |

The `db11-issues` CLI is intended to be resolved and invoked through its skill; this package does not install a global executable. `db11-spec` also includes its [OpenAI agent metadata](skills/db11-spec/agents/openai.yaml).

## Install

This repository defines the npm package identity and release configuration, but it does not establish current registry publication. When the package is available on npm, install it with:

```sh
pi install npm:@debonzi/db11-skills
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/db11-skills
```

Pi installs the complete package and discovers both skills under the declared `skills` resource by default. Use `pi config` to control global resource loading or `pi config -l` for project overrides. Resource configuration changes what Pi loads; it does not split or partially download the npm package.

Run `/skill:db11-issues` or `/skill:db11-spec` to load a skill explicitly. Pi may also load an enabled skill when its description matches the request.

## Migrate from the former DBZ package

The package and skills have new Pi identities:

| Former identity | DB11 replacement |
| --- | --- |
| `@debonzi/dbz-skills` | `@debonzi/db11-skills` |
| `dbz-issues` / `/skill:dbz-issues` | `db11-issues` / `/skill:db11-issues` |
| `dbz-spec` / `/skill:dbz-spec` | `db11-spec` / `/skill:db11-spec` |

There are no temporary aliases for the former package or skill names. Migrate explicitly after the DB11 npm package is available:

1. Run `pi list` in each relevant project. Under `User packages` (global) and `Project packages` (project-local), find the former source and copy the source value before any `(filtered)` status marker, including an npm version or Git ref when present. For a local source, use the resolved absolute path that Pi prints below it when removing; a relative local source in settings is not necessarily relative to the shell directory. If the package exists in both scopes, remove both entries separately.
2. Pass the copied npm or Git source, or the resolved local path, to `pi remove`, using `-l` only for a project-local entry. For the common unpinned npm source, the commands are:

   ```sh
   # Global installation
   pi remove npm:@debonzi/dbz-skills

   # Project-local installation
   pi remove npm:@debonzi/dbz-skills -l
   ```

   Use these literal commands only when `pi list` reports `npm:@debonzi/dbz-skills`; otherwise substitute the exact reported source.
3. Install the DB11 npm package in the intended scope:

   ```sh
   # Global installation
   pi install npm:@debonzi/db11-skills

   # Project-local installation
   pi install npm:@debonzi/db11-skills -l
   ```

4. Review global loading with `pi config` and project overrides with `pi config -l`. Package filters and enabled-resource choices that refer to the former package or skill identities do not transfer automatically. Configure `db11-issues` and `db11-spec` explicitly where needed; project overrides can still affect a global installation.
5. Run `/reload` in every running Pi session that should use the new package, or restart those sessions, after removal, installation, and filter changes.

Existing Markdown issue registries remain compatible with `db11-issues`. The transient reservation filename changed from `.NNN.dbz-issues-reservation` to `.NNN.db11-issues-reservation` and has no cross-version compatibility guarantee.

## Develop and test

From a full repository source checkout:

```sh
cd packages/db11-skills
python3 -m unittest discover -s skills/db11-issues/tests -v
npm pack --dry-run --ignore-scripts
```

The Python tests and other repository-only validation files are not included in the package tarball. Run `npm run check` and `npm run pack:check` from the repository root for the complete workspace validation.

## License

MIT
