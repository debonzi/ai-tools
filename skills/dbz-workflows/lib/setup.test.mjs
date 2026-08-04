import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	ConfirmationRequiredError,
	SetupError,
} from "./errors.mjs";
import { serializeFrontmatter } from "./frontmatter.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { parseExternalLocator } from "./locators.mjs";
import {
	externalLocatorPath,
	managedStoragePath,
	parseRootManifest,
	projectStoragePath,
	resolveActiveStorage,
	SHARED_LINEAGE_NOTICE,
} from "./storage.mjs";
import {
	applySetupPlan,
	createSetupPlan,
	ROOT_MANIFEST_BODY,
} from "./setup.mjs";

const execFileAsync = promisify(execFile);
const ROOT_COMMIT = "1".repeat(40);
const PROJECT_KEY = `git-sha1-${ROOT_COMMIT}`;
const TIMESTAMP = "2026-08-03T15:30:00.000Z";
const CLOCK = () => new Date(TIMESTAMP);

async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-setup-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function identity(projectRoot) {
	return {
		projectRoot,
		objectFormat: "sha1",
		rootCommit: ROOT_COMMIT,
		projectKey: PROJECT_KEY,
	};
}

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

function manifest(overrides = {}) {
	return serializeFrontmatter(
		{
			artifact: "project",
			schema_version: 1,
			project_key: PROJECT_KEY,
			project_name: "adopted-project",
			object_format: "sha1",
			root_commit: ROOT_COMMIT,
			next_workflow_number: 1,
			created_at: TIMESTAMP,
			updated_at: TIMESTAMP,
			...overrides,
		},
		ROOT_MANIFEST_BODY,
	);
}

async function initializeProject(directory) {
	const projectRoot = resolve(directory, "project");
	const homeDirectory = resolve(directory, "isolated-home");
	await mkdir(projectRoot);
	return { projectRoot, homeDirectory, identity: identity(projectRoot) };
}

test("setup safely creates project, managed, and exact external storage roots", async (t) => {
	await t.test("project storage reports uncommitted Git-visible setup changes", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			const plan = await createSetupPlan(context.identity, {
				mode: "project",
				homeDirectory: context.homeDirectory,
				clock: CLOCK,
			});
			assert.equal(plan.action, "create");
			assert.equal(plan.destination.selected_path, projectStoragePath(context.projectRoot));
			assert.deepEqual(plan.git_changes, [
				{ change: "created", path: "dbz-workflows/dbz-workflows.md" },
			]);

			const result = await applySetupPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			});
			assert.equal(result.changed, true);
			assert.equal(result.mode, "project");
			const source = await readFile(
				resolve(context.projectRoot, "dbz-workflows", "dbz-workflows.md"),
				"utf8",
			);
			const parsed = parseRootManifest(source, { expectedIdentity: context.identity });
			assert.equal(parsed.metadata.next_workflow_number, 1);
			assert.equal(parsed.metadata.created_at, TIMESTAMP);
			assert.equal(parsed.body, ROOT_MANIFEST_BODY);
		});
	});

	await t.test("managed storage uses the fixed home-relative path without initializing Git", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			const plan = await createSetupPlan(context.identity, {
				mode: "managed",
				homeDirectory: context.homeDirectory,
				clock: CLOCK,
			});
			await applySetupPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			});
			const expected = managedStoragePath(PROJECT_KEY, {
				homeDirectory: context.homeDirectory,
			});
			assert.equal(plan.destination.selected_path, expected);
			await assert.rejects(lstat(resolve(expected, ".git")), { code: "ENOENT" });
			assert.equal((await resolveActiveStorage(context.identity, {
				homeDirectory: context.homeDirectory,
			})).mode, "managed");
		});
	});

	await t.test("external storage keeps an explicitly selected symlink and writes a private locator", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			const effectivePath = resolve(directory, "effective-external");
			const selectedPath = resolve(directory, "selected-external");
			await mkdir(effectivePath);
			await symlink(effectivePath, selectedPath);
			const plan = await createSetupPlan(context.identity, {
				mode: "external",
				externalPath: selectedPath,
				homeDirectory: context.homeDirectory,
				clock: CLOCK,
			});
			assert.equal(plan.action, "initialize");
			assert.equal(plan.destination.selected_path, selectedPath);
			assert.equal(plan.destination.effective_path, effectivePath);
			assert.equal(plan.destination.selected_kind, "symlink");
			assert.equal(plan.lineage_notice.message, SHARED_LINEAGE_NOTICE);

			await applySetupPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			});
			assert.equal((await lstat(selectedPath)).isSymbolicLink(), true);
			assert.equal(await realpath(selectedPath), effectivePath);
			const locatorPath = externalLocatorPath(PROJECT_KEY, {
				homeDirectory: context.homeDirectory,
			});
			assert.equal((await stat(locatorPath)).mode & 0o777, 0o600);
			assert.equal((await stat(dirname(locatorPath))).mode & 0o077, 0);
			const locator = parseExternalLocator(await readFile(locatorPath, "utf8"));
			assert.equal(locator.storage_path, selectedPath);
			assert.equal(locator.updated_at, TIMESTAMP);
		});
	});
});

test("setup adopts only a valid same-lineage external root without changing its bytes", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializeProject(directory);
		const externalPath = resolve(directory, "existing-external");
		await mkdir(externalPath);
		const source = manifest({ unknown_extension: { retained: true } });
		const manifestPath = resolve(externalPath, "dbz-workflows.md");
		await writeFile(manifestPath, source);

		const plan = await createSetupPlan(context.identity, {
			mode: "external",
			externalPath,
			homeDirectory: context.homeDirectory,
			clock: CLOCK,
		});
		assert.equal(plan.action, "adopt");
		assert.equal(plan.root_manifest, null);
		await applySetupPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		assert.equal(await readFile(manifestPath, "utf8"), source);
		assert.deepEqual(
			parseRootManifest(source).metadata.unknown_extension,
			{ retained: true },
		);
	});
});

test("unchanged setup reruns are idempotent", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializeProject(directory);
		const firstPlan = await createSetupPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: CLOCK,
		});
		await applySetupPlan(firstPlan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(firstPlan),
		});
		const manifestPath = resolve(firstPlan.destination.effective_path, "dbz-workflows.md");
		const before = await readFile(manifestPath, "utf8");

		const rerun = await createSetupPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: () => new Date("2027-01-01T00:00:00Z"),
		});
		assert.equal(rerun.action, "noop");
		const result = await applySetupPlan(rerun, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(rerun),
		});
		assert.equal(result.changed, false);
		assert.equal(await readFile(manifestPath, "utf8"), before);
	});
});

test("setup refuses every conflicting destination state without overwriting it", async (t) => {
	await t.test("a non-empty directory without a manifest", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			const externalPath = resolve(directory, "external");
			await mkdir(externalPath);
			await writeFile(resolve(externalPath, "keep.txt"), "keep\n");
			await assert.rejects(
				createSetupPlan(context.identity, {
					mode: "external",
					externalPath,
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof SetupError && /non-empty/u.test(error.message),
			);
			assert.equal(await readFile(resolve(externalPath, "keep.txt"), "utf8"), "keep\n");
		});
	});

	await t.test("invalid and foreign manifests", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			for (const [name, source] of [
				["invalid", "---\nartifact: project\n---\n# Invalid\n"],
				["foreign", manifest({
					project_key: `git-sha1-${"2".repeat(40)}`,
					root_commit: "2".repeat(40),
				})],
			]) {
				const externalPath = resolve(directory, name);
				await mkdir(externalPath);
				await writeFile(resolve(externalPath, "dbz-workflows.md"), source);
				await assert.rejects(
					createSetupPlan(context.identity, {
						mode: "external",
						externalPath,
						homeDirectory: context.homeDirectory,
					}),
					(error) => error instanceof SetupError && /invalid or foreign/u.test(error.message),
				);
				assert.equal(await readFile(resolve(externalPath, "dbz-workflows.md"), "utf8"), source);
			}
		});
	});

	await t.test("external mode cannot alias either fixed storage path", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			for (const externalPath of [
				projectStoragePath(context.projectRoot),
				managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory }),
			]) {
				await assert.rejects(
					createSetupPlan(context.identity, {
						mode: "external",
						externalPath,
						homeDirectory: context.homeDirectory,
					}),
					(error) => error instanceof SetupError && /activate two modes/u.test(error.message),
				);
			}
		});
	});

	await t.test("fixed-root symlinks, regular files, dangling external symlinks, and file parents", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializeProject(directory);
			const target = resolve(directory, "target");
			await mkdir(target);
			await symlink(target, projectStoragePath(context.projectRoot));
			await assert.rejects(createSetupPlan(context.identity, {
				mode: "project",
				homeDirectory: context.homeDirectory,
			}));
			assert.equal((await lstat(projectStoragePath(context.projectRoot))).isSymbolicLink(), true);
			await rm(projectStoragePath(context.projectRoot));

			await mkdir(dirname(managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory })), {
				recursive: true,
			});
			await writeFile(managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory }), "keep\n");
			await assert.rejects(createSetupPlan(context.identity, {
				mode: "managed",
				homeDirectory: context.homeDirectory,
			}));
			await rm(managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory }));

			const dangling = resolve(directory, "dangling");
			await symlink(resolve(directory, "missing"), dangling);
			await assert.rejects(createSetupPlan(context.identity, {
				mode: "external",
				externalPath: dangling,
				homeDirectory: context.homeDirectory,
			}));
			await rm(dangling);

			const fileParent = resolve(directory, "file-parent");
			await writeFile(fileParent, "keep\n");
			await assert.rejects(createSetupPlan(context.identity, {
				mode: "external",
				externalPath: resolve(fileParent, "child"),
				homeDirectory: context.homeDirectory,
			}));
			assert.equal(await readFile(fileParent, "utf8"), "keep\n");
		});
	});
});

test("setup apply requires exact authorization and rejects stale destination revisions", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializeProject(directory);
		const plan = await createSetupPlan(context.identity, {
			mode: "project",
			homeDirectory: context.homeDirectory,
			clock: CLOCK,
		});
		await assert.rejects(
			applySetupPlan(plan, { identity: context.identity, homeDirectory: context.homeDirectory }),
			ConfirmationRequiredError,
		);
		await assert.rejects(
			applySetupPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: { confirmed: true, planDigest: "0".repeat(64) },
			}),
			ConfirmationRequiredError,
		);
		await mkdir(plan.destination.selected_path);
		await writeFile(resolve(plan.destination.selected_path, "appeared.txt"), "keep\n");
		await assert.rejects(applySetupPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		}));
		assert.equal(await readFile(resolve(plan.destination.selected_path, "appeared.txt"), "utf8"), "keep\n");
	});
});

test("setup redirects an active-storage mode change to explicit migration", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializeProject(directory);
		const plan = await createSetupPlan(context.identity, {
			mode: "project",
			homeDirectory: context.homeDirectory,
		});
		await applySetupPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		await assert.rejects(
			createSetupPlan(context.identity, {
				mode: "managed",
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof SetupError && /migration plan/u.test(error.message),
		);
	});
});

test("the non-interactive CLI separates planning from explicitly authorized apply", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "git-project");
		const homeDirectory = resolve(directory, "cli-home");
		const planPath = resolve(directory, "setup-plan.json");
		await mkdir(projectRoot);
		const environment = {
			...process.env,
			HOME: homeDirectory,
			GIT_AUTHOR_NAME: "DBZ Workflows Test",
			GIT_AUTHOR_EMAIL: "workflows-test@example.invalid",
			GIT_COMMITTER_NAME: "DBZ Workflows Test",
			GIT_COMMITTER_EMAIL: "workflows-test@example.invalid",
		};
		await execFileAsync("git", ["init", "--quiet"], { cwd: projectRoot, env: environment });
		await execFileAsync("git", ["commit", "--quiet", "--allow-empty", "-m", "initial"], {
			cwd: projectRoot,
			env: environment,
		});
		const script = resolve("skills/dbz-workflows/scripts/dbz-workflows.mjs");
		const planned = await execFileAsync(
			process.execPath,
			[script, "setup", "plan", "--mode", "managed", "--project", projectRoot],
			{ cwd: resolve("."), env: environment, encoding: "utf8" },
		);
		const plan = JSON.parse(planned.stdout);
		await writeFile(planPath, planned.stdout);
		await assert.rejects(
			execFileAsync(
				process.execPath,
				[script, "setup", "apply", "--plan-file", planPath, "--plan-digest", plan.plan_digest, "--project", projectRoot],
				{ cwd: resolve("."), env: environment, encoding: "utf8" },
			),
			(error) => error.code === 2 && /--authorize/u.test(error.stderr),
		);
		await assert.rejects(lstat(plan.destination.selected_path), { code: "ENOENT" });

		const applied = await execFileAsync(
			process.execPath,
			[
				script,
				"setup",
				"apply",
				"--plan-file",
				planPath,
				"--plan-digest",
				plan.plan_digest,
				"--authorize",
				"--project",
				projectRoot,
			],
			{ cwd: resolve("."), env: environment, encoding: "utf8" },
		);
		assert.equal(JSON.parse(applied.stdout).changed, true);
		const projectIdentity = await inspectGitProject(projectRoot);
		assert.equal((await resolveActiveStorage(projectIdentity, { homeDirectory })).mode, "managed");

		const externalPath = resolve(directory, "cli-external-storage");
		const migrationPlanPath = resolve(directory, "migration-plan.json");
		const migrationPlanned = await execFileAsync(
			process.execPath,
			[
				script,
				"migration",
				"plan",
				"--mode",
				"external",
				"--external-path",
				externalPath,
				"--project",
				projectRoot,
			],
			{ cwd: resolve("."), env: environment, encoding: "utf8" },
		);
		const migrationPlan = JSON.parse(migrationPlanned.stdout);
		await writeFile(migrationPlanPath, migrationPlanned.stdout);
		const migrationApplied = await execFileAsync(
			process.execPath,
			[
				script,
				"migration",
				"apply",
				"--plan-file",
				migrationPlanPath,
				"--plan-digest",
				migrationPlan.plan_digest,
				"--authorize",
				"--project",
				projectRoot,
			],
			{ cwd: resolve("."), env: environment, encoding: "utf8" },
		);
		assert.equal(JSON.parse(migrationApplied.stdout).changed, true);
		const migrated = await resolveActiveStorage(projectIdentity, { homeDirectory });
		assert.equal(migrated.mode, "external");
		assert.equal(migrated.path, externalPath);
	});
});
