# @debonzi/dbz-skills

A multi-skill Pi package for local issue management and implementation-ready specification workflows. The skills remain independently discoverable even though they share one distribution.

## Included skills

| Skill | Purpose | Prerequisites |
| --- | --- | --- |
| [`dbz-issues`](skills/dbz-issues/SKILL.md) | Manage dependency-aware Markdown issue registries through its bundled Python CLI | Python 3 |
| [`dbz-spec`](skills/dbz-spec/SKILL.md) | Guide discovery and produce an implementation-ready specification | No external executable |

The `dbz-issues` CLI is intended to be resolved and invoked through its skill; this package does not install a global executable. `dbz-spec` also includes its [OpenAI agent metadata](skills/dbz-spec/agents/openai.yaml).

## Install

Install the published package:

```sh
pi install npm:@debonzi/dbz-skills
```

For development from the repository root, install the local workspace instead:

```sh
pi install ./packages/dbz-skills
```

Pi installs the complete package and discovers both skills under the declared `skills` resource by default. Use `pi config` to control global resource loading or `pi config -l` for project overrides. Resource configuration changes what Pi loads; it does not split or partially download the npm package.

Run `/skill:dbz-issues` or `/skill:dbz-spec` to load a skill explicitly. Pi may also load an enabled skill when its description matches the request.

## Develop and test

From a full repository source checkout:

```sh
cd packages/dbz-skills
python3 -m unittest discover -s skills/dbz-issues/tests -v
npm pack --dry-run --ignore-scripts
```

The Python tests and other repository-only validation files are not included in the published tarball. Run `npm run check` and `npm run pack:check` from the repository root for the complete workspace validation.

## License

MIT
