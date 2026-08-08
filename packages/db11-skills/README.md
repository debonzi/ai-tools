# @debonzi/db11-skills

A multi-skill Pi package for local issue management and implementation-ready specification workflows. The skills remain independently discoverable even though they share one distribution.

## Included skills

| Skill | Purpose | Prerequisites |
| --- | --- | --- |
| [`db11-issues`](skills/db11-issues/SKILL.md) | Manage dependency-aware Markdown issue registries through its bundled Python CLI | Python 3 |
| [`db11-spec`](skills/db11-spec/SKILL.md) | Guide discovery and produce an implementation-ready specification | No external executable |

The `db11-issues` CLI is intended to be resolved and invoked through its skill; this package does not install a global executable. `db11-spec` also includes its [OpenAI agent metadata](skills/db11-spec/agents/openai.yaml).

## Install

Install the published package:

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

The former `@debonzi/dbz-skills` package and its `dbz-issues` and `dbz-spec` resources do not become DB11 resources automatically. Inspect `pi list`, remove the exact old package source it reports, install `@debonzi/db11-skills`, and review any global or project package filters for the new `db11-issues` and `db11-spec` names. Run `/reload` or restart Pi after changing the installation or filters.

No temporary DBZ skill aliases are bundled. Existing Markdown issue registries remain compatible, but the transient `.NNN.dbz-issues-reservation` filename has been replaced by `.NNN.db11-issues-reservation` and has no cross-version compatibility guarantee.

## Develop and test

From a full repository source checkout:

```sh
cd packages/db11-skills
python3 -m unittest discover -s skills/db11-issues/tests -v
npm pack --dry-run --ignore-scripts
```

The Python tests and other repository-only validation files are not included in the published tarball. Run `npm run check` and `npm run pack:check` from the repository root for the complete workspace validation.

## License

MIT
