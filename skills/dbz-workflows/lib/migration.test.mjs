import assert from "node:assert/strict";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
	ConfirmationRequiredError,
	MigrationError,
	PlanMismatchError,
	SetupError,
} from "./errors.mjs";
import { parseExternalLocator } from "./locators.mjs";
import {
	applyMigrationPlan,
	createMigrationPlan,
	MIGRATION_DISCLAIMER,
} from "./migration.mjs";
import {
	externalLocatorPath,
	managedStoragePath,
	projectStoragePath,
	resolveActiveStorage,
} from "./storage.mjs";
import {
	applySetupPlan,
	createSetupPlan,
} from "./setup.mjs";

const ROOT_COMMIT = "3".repeat(40);
const PROJECT_KEY = `git-sha1-${ROOT_COMMIT}`;
const SETUP_CLOCK = () => new Date("2026-08-03T15:30:00Z");
const MIGRATION_CLOCK = () => new Date("2026-08-03T15:31:02Z");

async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-migration-test-"));
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

async function initializedContext(directory, mode = "project", externalPath) {
	const projectRoot = resolve(directory, "project");
	const homeDirectory = resolve(directory, "home");
	await mkdir(projectRoot);
	const projectIdentity = identity(projectRoot);
	const setupPlan = await createSetupPlan(projectIdentity, {
		mode,
		...(externalPath === undefined ? {} : { externalPath }),
		homeDirectory,
		clock: SETUP_CLOCK,
	});
	await applySetupPlan(setupPlan, {
		identity: projectIdentity,
		homeDirectory,
		authorization: authorization(setupPlan),
	});
	return {
		projectRoot,
		homeDirectory,
		identity: projectIdentity,
		storagePath: setupPlan.destination.effective_path,
	};
}

async function addCanonicalFixture(storagePath) {
	await mkdir(resolve(storagePath, "WF-0001-example", "tickets"), { recursive: true });
	await writeFile(
		resolve(storagePath, "WF-0001-example", "workflow.md"),
		"---\nartifact: workflow\nschema_version: 1\n---\n# Workflow\n",
	);
	await writeFile(resolve(storagePath, "WF-0001-example", "tickets", "evidence.bin"), Buffer.from([0, 1, 2, 255]));
}

test("successful migration verifies bytes, activates managed storage, and preserves a timestamped backup", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializedContext(directory, "project");
		await addCanonicalFixture(context.storagePath);
		const originalManifest = await readFile(resolve(context.storagePath, "dbz-workflows.md"));
		const originalBinary = await readFile(
			resolve(context.storagePath, "WF-0001-example", "tickets", "evidence.bin"),
		);

		const plan = await createMigrationPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		});
		assert.equal(plan.disclaimer, MIGRATION_DISCLAIMER);
		assert.equal(plan.backup_path, `${context.storagePath}.migrated-20260803T153102Z`);
		assert.equal(plan.destination.selected_path, managedStoragePath(PROJECT_KEY, {
			homeDirectory: context.homeDirectory,
		}));
		assert.ok(plan.source.tree_digest.length === 64);

		const result = await applyMigrationPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		assert.equal(result.changed, true);
		assert.equal(result.backup_path, plan.backup_path);
		assert.deepEqual(result.cleanup_warnings, []);
		assert.deepEqual(
			await readFile(resolve(plan.destination.effective_path, "dbz-workflows.md")),
			originalManifest,
		);
		assert.deepEqual(
			await readFile(resolve(plan.destination.effective_path, "WF-0001-example", "tickets", "evidence.bin")),
			originalBinary,
		);
		assert.deepEqual(
			await readFile(resolve(plan.backup_path, "WF-0001-example", "tickets", "evidence.bin")),
			originalBinary,
		);
		await assert.rejects(lstat(context.storagePath), { code: "ENOENT" });
		assert.equal((await resolveActiveStorage(context.identity, {
			homeDirectory: context.homeDirectory,
		})).mode, "managed");
	});
});

test("migration activates and removes external locators while retaining exact selected paths", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializedContext(directory, "managed");
		const externalTarget = resolve(directory, "external-target");
		const selectedExternal = resolve(directory, "external-selected-link");
		await mkdir(externalTarget);
		await symlink(externalTarget, selectedExternal);

		const toExternal = await createMigrationPlan(context.identity, {
			mode: "external",
			externalPath: selectedExternal,
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		});
		assert.equal(toExternal.destination.selected_kind, "symlink");
		await applyMigrationPlan(toExternal, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(toExternal),
		});
		assert.equal((await lstat(selectedExternal)).isSymbolicLink(), true);
		assert.equal(await realpath(selectedExternal), externalTarget);
		const locatorPath = externalLocatorPath(PROJECT_KEY, { homeDirectory: context.homeDirectory });
		assert.equal((await stat(locatorPath)).mode & 0o777, 0o600);
		assert.equal(
			parseExternalLocator(await readFile(locatorPath, "utf8")).storage_path,
			selectedExternal,
		);
		assert.equal((await resolveActiveStorage(context.identity, {
			homeDirectory: context.homeDirectory,
		})).path, selectedExternal);

		const toProject = await createMigrationPlan(context.identity, {
			mode: "project",
			homeDirectory: context.homeDirectory,
			clock: () => new Date("2026-08-03T15:32:03Z"),
		});
		await applyMigrationPlan(toProject, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(toProject),
		});
		await assert.rejects(lstat(locatorPath), { code: "ENOENT" });
		assert.equal((await resolveActiveStorage(context.identity, {
			homeDirectory: context.homeDirectory,
		})).mode, "project");
		assert.equal((await lstat(selectedExternal)).isSymbolicLink(), true);
		await assert.rejects(realpath(selectedExternal), { code: "ENOENT" });
		assert.equal((await lstat(toProject.backup_path)).isDirectory(), true);
	});
});

test("migration apply is idempotent when the requested mode and path are already active", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializedContext(directory, "managed");
		const plan = await createMigrationPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		});
		assert.equal(plan.action, "noop");
		const result = await applyMigrationPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		assert.equal(result.changed, false);
		await assert.rejects(lstat(plan.backup_path), { code: "ENOENT" });
	});
});

test("failed cross-filesystem-style copy and activation simulations leave the source active", async (t) => {
	for (const failure of ["copy", "activation", "post-backup"]) {
		await t.test(failure, async () => {
			await withTemporaryDirectory(async (directory) => {
				const context = await initializedContext(directory, "project");
				await addCanonicalFixture(context.storagePath);
				const plan = await createMigrationPlan(context.identity, {
					mode: "managed",
					homeDirectory: context.homeDirectory,
					clock: MIGRATION_CLOCK,
				});
				const options = {
					identity: context.identity,
					homeDirectory: context.homeDirectory,
					authorization: authorization(plan),
				};
				if (failure === "copy") {
					options.copyTree = async () => {
						const error = new Error("simulated cross-filesystem copy failure");
						error.code = "EXDEV";
						throw error;
					};
				} else if (failure === "activation") {
					options.hooks = {
						afterDestinationActivation() {
							throw new Error("simulated activation failure");
						},
					};
				} else {
					options.hooks = {
						afterSourceBackup() {
							throw new Error("simulated post-backup failure");
						},
					};
				}
				await assert.rejects(
					applyMigrationPlan(plan, options),
					(error) =>
						error instanceof MigrationError &&
						error.details.source_active === true &&
						/original storage root remains active/u.test(error.message),
				);
				const active = await resolveActiveStorage(context.identity, {
					homeDirectory: context.homeDirectory,
				});
				assert.equal(active.mode, "project");
				assert.equal(active.path, context.storagePath);
				await assert.rejects(lstat(plan.destination.selected_path), { code: "ENOENT" });
				await assert.rejects(lstat(plan.backup_path), { code: "ENOENT" });
				await assert.rejects(lstat(plan.temporary_path), { code: "ENOENT" });
			});
		});
	}
});

test("migration refuses occupied, adoptable, symlinked fixed, and nested destinations", async (t) => {
	await t.test("occupied destination without a manifest", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializedContext(directory, "project");
			const destination = managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory });
			await mkdir(destination, { recursive: true });
			await writeFile(resolve(destination, "keep.txt"), "keep\n");
			await assert.rejects(
				createMigrationPlan(context.identity, {
					mode: "managed",
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof SetupError && /non-empty/u.test(error.message),
			);
			assert.equal(await readFile(resolve(destination, "keep.txt"), "utf8"), "keep\n");
		});
	});

	await t.test("existing same-lineage root is not merged", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializedContext(directory, "project");
			const externalPath = resolve(directory, "adoptable-destination");
			await mkdir(externalPath);
			await writeFile(
				resolve(externalPath, "dbz-workflows.md"),
				await readFile(resolve(context.storagePath, "dbz-workflows.md")),
			);
			await assert.rejects(
				createMigrationPlan(context.identity, {
					mode: "external",
					externalPath,
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof SetupError && /will not merge/u.test(error.message),
			);
		});
	});

	await t.test("fixed destination symlink is not replaced", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializedContext(directory, "project");
			const target = resolve(directory, "managed-target");
			await mkdir(target);
			const destination = managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory });
			await mkdir(resolve(destination, ".."), { recursive: true });
			await symlink(target, destination);
			await assert.rejects(createMigrationPlan(context.identity, {
				mode: "managed",
				homeDirectory: context.homeDirectory,
			}));
			assert.equal((await lstat(destination)).isSymbolicLink(), true);
		});
	});

	await t.test("destination nested inside the source", async () => {
		await withTemporaryDirectory(async (directory) => {
			const context = await initializedContext(directory, "project");
			const nested = resolve(context.storagePath, "nested-external");
			await assert.rejects(
				createMigrationPlan(context.identity, {
					mode: "external",
					externalPath: nested,
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof SetupError && /non-nested/u.test(error.message),
			);
		});
	});
});

test("migration requires exact authorization and rejects source or destination changes after planning", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializedContext(directory, "project");
		const plan = await createMigrationPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		});
		await assert.rejects(
			applyMigrationPlan(plan, { identity: context.identity, homeDirectory: context.homeDirectory }),
			ConfirmationRequiredError,
		);
		await writeFile(resolve(context.storagePath, "human-edit.txt"), "changed after review\n");
		await assert.rejects(
			applyMigrationPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			}),
			PlanMismatchError,
		);
		assert.equal((await resolveActiveStorage(context.identity, {
			homeDirectory: context.homeDirectory,
		})).mode, "project");

		const freshPlan = await createMigrationPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		});
		await mkdir(freshPlan.destination.selected_path, { recursive: true });
		await writeFile(resolve(freshPlan.destination.selected_path, "appeared.txt"), "keep\n");
		await assert.rejects(applyMigrationPlan(freshPlan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(freshPlan),
		}));
		assert.equal(await readFile(resolve(freshPlan.destination.selected_path, "appeared.txt"), "utf8"), "keep\n");
	});
});

test("migration planning validates source manifests without modifying the source", async () => {
	await withTemporaryDirectory(async (directory) => {
		const context = await initializedContext(directory, "project");
		await mkdir(resolve(context.storagePath, "WF-0001-example"));
		const malformedPath = resolve(context.storagePath, "WF-0001-example", "spec.md");
		await writeFile(malformedPath, "# Missing frontmatter\n");
		await assert.rejects(createMigrationPlan(context.identity, {
			mode: "managed",
			homeDirectory: context.homeDirectory,
			clock: MIGRATION_CLOCK,
		}));
		assert.equal(await readFile(malformedPath, "utf8"), "# Missing frontmatter\n");
		assert.deepEqual((await readdir(context.projectRoot)).sort(), ["dbz-workflows"]);
		await assert.rejects(
			lstat(managedStoragePath(PROJECT_KEY, { homeDirectory: context.homeDirectory })),
			{ code: "ENOENT" },
		);
	});
});
