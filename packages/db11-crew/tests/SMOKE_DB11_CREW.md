# DB11 Crew Smoke Test

Use this procedure only on local resources. It does not authorize network access, package publication, remote Git operations, or changes to an existing Pi, Herdr, or legacy DBZ installation. Run the deterministic sections first; perform the interactive sections only when the required local tools and a separately approved disposable repository are available.

Resolve `<db11-crew>` through the loaded skill as `python3 <db11-crew-skill-directory>/scripts/db11-crew`. Never assume that the CLI is installed in `PATH`.

## 1. Automated baseline and clean package installation

From a clean repository checkout:

```bash
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=all)"
python3 -m unittest discover -s packages/db11-crew/skills/db11-crew/tests -v
TZ=UTC node --test packages/db11-crew/agents/pi/extensions/db11-crew-events/index.test.ts
python3 tests/test_package.py -v
tests/test-package-install.sh
bash -n tests/test-package-install.sh
```

The isolated installation test packs each local workspace and installs it under a temporary `HOME` and `PI_CODING_AGENT_DIR`; it does not contact a published DB11 package. Confirm its DB11 Crew case proves all of the following:

- the archive and installed manifest are `@debonzi/db11-crew` and contain exactly the two DB11 skills, bundled CLI/reference, and DB11 event extension;
- `pi list --no-approve` reports only the temporary DB11 package source, without a package filter;
- RPC discovery loads `skill:db11-crew` and `skill:db11-crew-setup` without an extension error;
- no former DBZ skill command or resource path is present;
- installation creates neither a trust decision nor a `db11-crew` executable in `PATH`;
- an inert non-Herdr Pi startup creates neither the DB11 state tree nor a legacy tree.

Run `npm run pack:check` as the final archive allowlist check. A failure is a blocker; do not substitute a global installation.

## 2. Installed-resource and cutover audit

Before using an existing Pi profile, run the setup skill's read-only discovery and inspect:

```bash
pi list --no-approve
```

Review both `User packages` and `Project packages`. The intended DB11 source must be in the expected scope. If it is marked `(filtered)`, inspect both `pi config` and, where applicable, `pi config -l`; `db11-crew`, `db11-crew-setup`, and `db11-crew-events` must all be enabled.

Treat any former standalone or aggregate npm source, rolling Git or local checkout, old package filter, or top-level `dbz-crew`, `dbz-crew-setup`, `dbz-ai-tools-setup`, or `dbz-crew-events` path as stale. Include broken symlinks in the audit, but do not follow them. Confirm `/skill:db11-crew-setup` reports the exact stale source or path and stops before an integration mutation. It must not remove packages or resources, edit filters, change trust, or inspect legacy state.

A pre-existing `~/.local/state/dbz-crew` tree is preserved rollback state, not a stale installed resource. If a former runtime is installed, stop here until the user explicitly completes or cleans its workers with that runtime, removes each exact source in the correct global or project scope, reviews filters, and reloads Pi. Do not run DB11 and the former namespace concurrently in one repository.

For a real clean installation, use only an already authorized source:

```bash
pi install npm:@debonzi/db11-crew       # only when registry access was separately authorized
# or, from this checkout:
pi install ./packages/db11-crew
pi list --no-approve
```

Run `/reload` or restart Pi, then invoke `/skill:db11-crew-setup`. Confirm it shows all preflight results and the complete plan before asking for separate confirmation of `herdr integration install pi`. If the integration is already current, it must perform no mutation.

## 3. Hard-cutover and untouched-state checks

The Python and TypeScript suites create controlled legacy trees and verify that DB11 startup leaves their contents and permissions unchanged. They also prove that `DBZ_CREW_STATE_DIR`, legacy events, and legacy delivered markers do not configure or acknowledge DB11 work.

When an actual legacy tree exists, do not create, edit, chmod, archive, or remove it for this smoke test. Compare only metadata or checksums that the owner separately approves inspecting, record evidence outside the repository, and confirm it is identical before and after DB11 setup, extension startup, event delivery, and lifecycle operations. Verify that:

- all new state appears only below `~/.local/state/db11-crew`;
- the legacy root is not moved, merged, followed, or permission-repaired;
- repeated DB11 startup is idempotent while both trees exist;
- an intentionally unsafe DB11 state path fails closed without changing the legacy tree;
- rollback remains possible by stopping DB11 workers, switching package sources and filters, and reloading Pi without transforming either state tree.

Do not manufacture an unsafe path or alter a real legacy tree. Use the deterministic tests for destructive or adversarial cases.

## 4. Interactive implementation lifecycle and event delivery

Use a disposable local Git repository with a clean local `main` inside a Herdr-managed interactive Pi session. Complete the setup workflow first.

1. Run `<db11-crew> preflight`. Confirm `ok: true`, `principal_agent: "pi"`, the original Pi session ID, and the active provider, model, and thinking level.
2. Explicitly ask Pi to delegate one bounded file change. Confirm the dispatch creates a `db11-crew/<suffix>/<task>` branch, an isolated worktree, one worker tab, and one monitor; no `dbz-crew/` branch is created.
3. Run `<db11-crew> status` only for a snapshot. Confirm the worker is recorded as running and the principal remains available rather than waiting.
4. In the worker tab, confirm the process is Pi, startup arguments inherit the principal runtime metadata, the final response contains `DB11-CREW RESULT:`, and changed source is committed with a Conventional Commit.
5. Keep the principal busy with an independent turn until completion. Confirm the event does not steer that turn and arrives afterward with follow-up delivery. Confirm the principal reads the private result, reports it, and does not automatically rebase, integrate, or clean up.
6. Run `<db11-crew> status` and confirm the terminal worker state and result path. Verify the event belongs to the original session and that a `db11-crew-event-delivered` acknowledgement prevents redelivery after `/reload`.
7. For recovery, dispatch another bounded task, exit before its event is delivered, then resume the same Pi session after the worker finishes. Confirm the pending event is recovered once as a follow-up. Do not use a different session for this check.
8. Explicitly request `rebase --task-id <task>`, then `integrate --branch <worker-branch>`, then `cleanup --task-id <task> --branch <worker-branch>` in separate turns. Confirm each reruns strict preflight, integration creates a local non-fast-forward merge only from a branch based on current `main`, and cleanup removes only the clean merged worktree, branch, and worker tab.
9. In separate disposable attempts, make `main` dirty or non-current and confirm dispatch, rebase, integration, and cleanup fail before mutation. Confirm integration rejects a stale branch and cleanup rejects active, dirty, or unmerged work.

Herdr notifications may accompany completion, but only the DB11 Pi event extension provides session-addressed follow-up delivery.

## 5. Read-only lifecycle

1. On a non-main branch, modify a tracked file and add both a non-ignored untracked file and an ignored file.
2. Run `<db11-crew> preflight --read-only` and confirm it succeeds while reporting the branch and dirty state.
3. Delegate a bounded inspection with `<db11-crew> dispatch --read-only --task-id <id> --prompt '<inspection>'`.
4. Confirm the isolated worktree contains the tracked change and non-ignored untracked file but not the ignored file.
5. Confirm an unchanged snapshot emits a completion event and automatically removes the worker tab, branch, and worktree while retaining the private result.
6. Repeat with a worker instructed to create a file. Confirm validation fails and retains its resources for inspection.
7. Use `--read-only --committed-only` and confirm local changes are absent. Repeat with `--base <ref>` and confirm the requested committed tree is used.
8. Run an explicitly requested `--read-only --in-place` inspection, change the source concurrently, and confirm the result warns without attributing or failing on that change.
9. Confirm read-only workers cannot be rebased or integrated and that ordinary implementation lifecycle commands still enforce clean local `main`.

## 6. Package and repository isolation

After setup, verify:

```bash
pi list --no-approve
test -f ~/.pi/agent/extensions/herdr-agent-state.ts
test ! -e ~/.local/bin/db11-crew
test -z "$(git status --porcelain --untracked-files=all)"
```

Confirm no DB11 skill or event-extension path points into this checkout when testing an npm installation. The package's two skills and extension must load together without installer-created filters or trust decisions. Installing or updating Herdr's Pi integration must not create files under the repository root's `agents/pi/extensions/` directory or modify any workspace.

Finish with `git status --short --branch`. Remove only disposable smoke resources whose cleanup was explicitly approved; never clean a legacy state tree as part of this procedure.
