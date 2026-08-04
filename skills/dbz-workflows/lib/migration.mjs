import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	MigrationError,
	PlanMismatchError,
	SetupError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	sha256Hex,
	withLocalMutationLock,
} from "./filesystem.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { serializeExternalLocator } from "./locators.mjs";
import {
	externalLocatorPath,
	parseRootManifest,
	resolveActiveStorage,
	ROOT_MANIFEST_NAME,
	validateStorageIdentity,
} from "./storage.mjs";
import {
	assertExternalDestinationIsDistinct,
	assertPlanIdentity,
	calculatePlanDigest,
	finalizePlan,
	inspectLocatorState,
	inspectSetupDestination,
	migrationTemporaryName,
	operationLockPath,
	prepareOperationLock,
	requirePlanAuthorization,
	storagePathForMode,
	validateReviewedPlan,
	writeExternalLocatorAtomically,
} from "./setup.mjs";

export const MIGRATION_DISCLAIMER =
	"Migration may cross filesystem boundaries and cannot be fully atomic. DBZ Workflows will lock its own operations, verify the copied files, and preserve the original directory as a timestamped backup. It cannot prevent external processes from modifying these files during migration.";

function migrationProblem(message, details, cause) {
	return new MigrationError(message, {
		details,
		...(cause === undefined ? {} : { cause }),
	});
}

function timestampFromClock(clock) {
	if (typeof clock !== "function") throw new ValidationError("clock must be a function.");
	const value = clock();
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError("clock must return a valid timestamp.");
	return date.toISOString();
}

function backupTimestamp(timestamp) {
	return timestamp.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function isNestedPath(root, candidate) {
	const difference = relative(root, candidate);
	return (
		difference !== "" &&
		difference !== ".." &&
		!difference.startsWith(`..${sep}`) &&
		!isAbsolute(difference)
	);
}

function pathRelation(first, second) {
	if (relative(first, second) === "") return "same";
	if (isNestedPath(first, second)) return "contains";
	if (isNestedPath(second, first)) return "inside";
	return "separate";
}

async function assertPathAbsent(path, description) {
	try {
		await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	throw new SetupError(`${description} already exists and will not be overwritten.`, {
		details: { path },
	});
}

function sourceFromActive(active) {
	return {
		mode: active.mode,
		selected_path: active.path,
		effective_path: active.effectivePath,
		manifest_digest: active.manifestDigest,
		locator_digest: active.locator?.digest ?? null,
	};
}

function sourceMatches(expected, actual) {
	return (
		expected.mode === actual.mode &&
		expected.selected_path === actual.path &&
		expected.effective_path === actual.effectivePath &&
		expected.manifest_digest === actual.manifestDigest &&
		expected.locator_digest === (actual.locator?.digest ?? null)
	);
}

function destinationMatches(expected, actual) {
	return (
		expected.selected_path === actual.selected_path &&
		expected.effective_path === actual.effective_path &&
		expected.selected_kind === actual.selected_kind &&
		expected.state === actual.state &&
		expected.manifest_digest === actual.manifest_digest
	);
}

function locatorMatches(expected, actual) {
	return expected.path === actual.path && expected.state === actual.state && expected.digest === actual.digest;
}

export async function createMigrationPlan(
	identity,
	{
		mode,
		externalPath,
		homeDirectory = homedir(),
		clock = () => new Date(),
	} = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const source = await resolveActiveStorage(normalizedIdentity, { homeDirectory: normalizedHome });
	const selectedPath = storagePathForMode(
		normalizedIdentity,
		mode,
		externalPath,
		normalizedHome,
	);
	const destination = await inspectSetupDestination(mode, selectedPath, normalizedIdentity);
	if (mode === "external") {
		await assertExternalDestinationIsDistinct(destination, normalizedIdentity, {
			homeDirectory: normalizedHome,
		});
	}
	const createdAt = timestampFromClock(clock);
	const locatorPath = externalLocatorPath(normalizedIdentity.projectKey, {
		homeDirectory: normalizedHome,
	});
	const locator = await inspectLocatorState(locatorPath, normalizedIdentity.projectKey);

	const sameStorage = source.mode === mode && source.path === selectedPath;
	if (!sameStorage && destination.state !== "missing" && destination.state !== "empty") {
		throw new SetupError(
			"Migration requires a missing or empty destination and will not merge with an existing storage root.",
			{
				details: {
					storage_path: selectedPath,
					destination_state: destination.state,
				},
			},
		);
	}
	if (!sameStorage) {
		const relation = pathRelation(source.effectivePath, destination.effective_path);
		if (relation !== "separate") {
			throw new SetupError("Migration source and destination must be separate, non-nested paths.", {
				details: {
					source_path: source.effectivePath,
					destination_path: destination.effective_path,
					relation,
				},
			});
		}
	}

	const token = sha256Hex(
		`${normalizedIdentity.projectKey}\0${source.effectivePath}\0${destination.effective_path}\0${createdAt}`,
	).slice(0, 24);
	const temporaryPath = resolve(
		dirname(destination.effective_path),
		migrationTemporaryName(destination.effective_path, token),
	);
	const emptyPlaceholderPath = `${temporaryPath}.previous-empty`;
	const backupPath = `${source.effectivePath}.migrated-${backupTimestamp(createdAt)}`;
	if (!sameStorage) {
		await assertPathAbsent(temporaryPath, "Migration temporary destination");
		await assertPathAbsent(emptyPlaceholderPath, "Migration empty-directory placeholder");
		await assertPathAbsent(backupPath, "Migration backup destination");
	}

	await validateStorageManifests(source.effectivePath, normalizedIdentity);
	const sourceTree = await treeSnapshot(source.effectivePath);
	const sourcePlan = {
		...sourceFromActive(source),
		tree_digest: storageTreeDigest(sourceTree),
	};
	return finalizePlan({
		operation: "migration",
		plan_version: 1,
		created_at: createdAt,
		identity: {
			project_root: normalizedIdentity.projectRoot,
			object_format: normalizedIdentity.objectFormat,
			root_commit: normalizedIdentity.rootCommit,
			project_key: normalizedIdentity.projectKey,
		},
		home_directory: normalizedHome,
		action: sameStorage ? "noop" : "migrate",
		source: sourcePlan,
		destination: { mode, ...destination },
		locator: {
			path: locator.path,
			state: locator.state,
			digest: locator.digest,
			...(locator.locator === undefined ? {} : { storage_path: locator.locator.storage_path }),
		},
		temporary_path: temporaryPath,
		empty_placeholder_path: emptyPlaceholderPath,
		backup_path: backupPath,
		disclaimer: MIGRATION_DISCLAIMER,
		changes: sameStorage
			? []
			: [
				{ action: "verified_copy", from: source.effectivePath, to: temporaryPath },
				{ action: "activate_destination", path: destination.effective_path },
				...(mode === "external"
					? [{ action: "write_external_locator", path: locator.path }]
					: source.mode === "external"
						? [{ action: "remove_external_locator", path: locator.path }]
						: []),
				{ action: "preserve_source_backup", from: source.effectivePath, to: backupPath },
			],
		git_changes: sameStorage || (source.mode !== "project" && mode !== "project")
			? []
			: [
				...(source.mode === "project"
					? [{
						change: "renamed",
						path: relative(normalizedIdentity.projectRoot, source.path),
						to: relative(normalizedIdentity.projectRoot, backupPath),
					}]
					: []),
				...(mode === "project"
					? [{ change: "created", path: relative(normalizedIdentity.projectRoot, destination.selected_path) }]
					: []),
			],
	});
}

async function treeSnapshot(root, { includeData = false } = {}) {
	const rootEntry = await lstat(root);
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
		throw migrationProblem("A storage tree root must be a directory and must not be a symbolic link.", {
			path: root,
		});
	}
	const entries = [];
	async function visitDirectory(directory, relativeDirectory) {
		const names = (await readdir(directory)).sort();
		for (const name of names) {
			const path = resolve(directory, name);
			const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
			const entry = await lstat(path);
			if (entry.isSymbolicLink()) {
				throw migrationProblem("Storage migration refuses symbolic links inside the source tree.", {
					path,
					relative_path: relativePath,
				});
			}
			if (entry.isDirectory()) {
				entries.push({ path: relativePath, type: "directory", mode: entry.mode & 0o777 });
				await visitDirectory(path, relativePath);
				continue;
			}
			if (!entry.isFile()) {
				throw migrationProblem("Storage migration supports only regular files and directories.", {
					path,
					relative_path: relativePath,
				});
			}
			const snapshot = await readFileWithDigest(path);
			entries.push({
				path: relativePath,
				type: "file",
				mode: entry.mode & 0o777,
				digest: snapshot.digest,
				...(includeData ? { data: snapshot.data } : {}),
			});
		}
	}
	await visitDirectory(root, "");
	return entries;
}

function comparableEntries(entries) {
	return entries.map(({ path, type, digest }) => ({
		path,
		type,
		...(digest === undefined ? {} : { digest }),
	}));
}

function storageTreeDigest(entries) {
	return sha256Hex(`${JSON.stringify(comparableEntries(entries))}\n`);
}

export async function copyStorageTree(sourcePath, temporaryPath) {
	await assertPathAbsent(temporaryPath, "Migration temporary destination");
	const sourceRootEntry = await lstat(sourcePath);
	if (sourceRootEntry.isSymbolicLink() || !sourceRootEntry.isDirectory()) {
		throw migrationProblem("Migration source is not a safe storage directory.", { source_path: sourcePath });
	}
	await mkdir(temporaryPath, { mode: 0o700 });
	try {
		const sourceEntries = await treeSnapshot(sourcePath, { includeData: true });
		for (const entry of sourceEntries) {
			const target = resolve(temporaryPath, entry.path);
			if (entry.type === "directory") {
				await mkdir(target, { mode: entry.mode });
				continue;
			}
			await atomicWriteFile(target, entry.data, {
				expectedDigest: null,
				mode: entry.mode,
				root: temporaryPath,
			});
		}
		for (const entry of [...sourceEntries].reverse()) {
			if (entry.type === "directory") await chmod(resolve(temporaryPath, entry.path), entry.mode);
		}
		await chmod(temporaryPath, sourceRootEntry.mode & 0o777);
		return { entries: comparableEntries(sourceEntries), digest: storageTreeDigest(sourceEntries) };
	} catch (error) {
		throw migrationProblem("Failed to copy the storage tree to the temporary destination.", {
			source_path: sourcePath,
			temporary_path: temporaryPath,
		}, error);
	}
}

export async function compareStorageTrees(sourcePath, copiedPath) {
	const [sourceEntries, copiedEntries] = await Promise.all([
		treeSnapshot(sourcePath),
		treeSnapshot(copiedPath),
	]);
	const sourceComparable = comparableEntries(sourceEntries);
	const copiedComparable = comparableEntries(copiedEntries);
	if (JSON.stringify(sourceComparable) !== JSON.stringify(copiedComparable)) {
		throw migrationProblem("The copied storage tree does not match the source bytes.", {
			source_path: sourcePath,
			copied_path: copiedPath,
			source_tree_digest: storageTreeDigest(sourceEntries),
			copied_tree_digest: storageTreeDigest(copiedEntries),
		});
	}
	return { entries: sourceComparable, digest: storageTreeDigest(sourceEntries) };
}

export async function validateStorageManifests(storagePath, identity) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const entries = await treeSnapshot(storagePath);
	for (const entry of entries) {
		if (entry.type !== "file" || !entry.path.endsWith(".md")) continue;
		const path = resolve(storagePath, entry.path);
		const source = await readFile(path, "utf8");
		if (entry.path === ROOT_MANIFEST_NAME) {
			parseRootManifest(source, { path, expectedIdentity: normalizedIdentity });
		} else {
			parseFrontmatter(source, { path });
		}
	}
	if (!entries.some(({ path, type }) => path === ROOT_MANIFEST_NAME && type === "file")) {
		throw migrationProblem("The copied storage tree is missing its root manifest.", {
			storage_path: storagePath,
		});
	}
}

async function withOperationLocks(lockPaths, callback, lockOptions) {
	const paths = [...new Set(lockPaths)].sort();
	for (const path of paths) await prepareOperationLock(path);
	async function acquire(index) {
		if (index === paths.length) return callback();
		return withLocalMutationLock(paths[index], () => acquire(index + 1), lockOptions);
	}
	return acquire(0);
}

async function verifyPlannedState(plan, identity, homeDirectory) {
	const active = await resolveActiveStorage(identity, { homeDirectory });
	if (!sourceMatches(plan.source, active)) {
		throw new PlanMismatchError("The active migration source changed after the plan was reviewed.", {
			details: { expected: plan.source, actual: sourceFromActive(active) },
		});
	}
	await validateStorageManifests(active.effectivePath, identity);
	const currentTreeDigest = storageTreeDigest(await treeSnapshot(active.effectivePath));
	if (plan.source.tree_digest !== currentTreeDigest) {
		throw new PlanMismatchError("The migration source contents changed after the plan was reviewed.", {
			details: { expected_tree_digest: plan.source.tree_digest, actual_tree_digest: currentTreeDigest },
		});
	}
	const destination = await inspectSetupDestination(
		plan.destination.mode,
		plan.destination.selected_path,
		identity,
	);
	if (plan.destination.mode === "external") {
		await assertExternalDestinationIsDistinct(destination, identity, { homeDirectory });
	}
	if (!destinationMatches(plan.destination, destination)) {
		throw new PlanMismatchError("The migration destination changed after the plan was reviewed.", {
			details: { expected: plan.destination, actual: destination },
		});
	}
	const locator = await inspectLocatorState(plan.locator.path, identity.projectKey);
	if (!locatorMatches(plan.locator, locator)) {
		throw new PlanMismatchError("The external locator changed after the migration plan was reviewed.");
	}
	return { active, destination, locator };
}

async function verifyReviewedMigrationState(plan, identity, homeDirectory) {
	try {
		return await verifyPlannedState(plan, identity, homeDirectory);
	} catch (error) {
		if (error instanceof PlanMismatchError) throw error;
		throw new PlanMismatchError("Migration state changed after the plan was reviewed.", {
			cause: error,
		});
	}
}

async function ensureDestinationParent(destination) {
	await mkdir(dirname(destination.effective_path), { recursive: true, mode: 0o700 });
	const parent = await lstat(dirname(destination.effective_path));
	if (parent.isSymbolicLink() || !parent.isDirectory()) {
		throw migrationProblem("Migration destination parent is not a safe directory.", {
			path: dirname(destination.effective_path),
		});
	}
}

async function activateCopiedDestination(plan, treeDigest) {
	const destinationPath = plan.destination.effective_path;
	const temporaryPath = plan.temporary_path;
	const temporaryEntry = await lstat(temporaryPath);
	let placeholderActive = false;
	let destinationActivated = false;
	try {
		if (plan.destination.state === "empty") {
			await rename(destinationPath, plan.empty_placeholder_path);
			placeholderActive = true;
		}
		await rename(temporaryPath, destinationPath);
		destinationActivated = true;
		const activeEntry = await lstat(destinationPath);
		if (
			activeEntry.isSymbolicLink() ||
			!activeEntry.isDirectory() ||
			activeEntry.dev !== temporaryEntry.dev ||
			activeEntry.ino !== temporaryEntry.ino
		) {
			throw new Error("The activated destination is not the verified temporary directory.");
		}
		if (plan.destination.mode === "external") {
			const effective = await realpath(plan.destination.selected_path);
			if (effective !== destinationPath) {
				throw new Error("The external selected path no longer resolves to the reviewed destination.");
			}
		}
		return {
			path: destinationPath,
			dev: activeEntry.dev,
			ino: activeEntry.ino,
			treeDigest,
			placeholderActive,
		};
	} catch (error) {
		if (destinationActivated) {
			try {
				const activeEntry = await lstat(destinationPath);
				if (activeEntry.dev === temporaryEntry.dev && activeEntry.ino === temporaryEntry.ino) {
					await rename(destinationPath, temporaryPath);
					destinationActivated = false;
				}
			} catch {}
		}
		if (placeholderActive && !destinationActivated) {
			await rename(plan.empty_placeholder_path, destinationPath).catch(() => {});
		}
		throw migrationProblem("Failed to activate the verified migration destination.", {
			destination_path: destinationPath,
		}, error);
	}
}

async function safeRemoveTree(path, expectedTreeDigest) {
	let entries;
	try {
		entries = await treeSnapshot(path);
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
	if (storageTreeDigest(entries) !== expectedTreeDigest) return false;
	await rm(path, { recursive: true, force: false });
	return true;
}

async function rollbackDestination(plan, activation) {
	if (!activation) return;
	const current = await lstat(activation.path);
	if (
		current.isSymbolicLink() ||
		!current.isDirectory() ||
		current.dev !== activation.dev ||
		current.ino !== activation.ino
	) {
		throw new Error("The activated destination changed and cannot be rolled back safely.");
	}
	await assertPathAbsent(plan.temporary_path, "Migration rollback temporary path");
	await rename(activation.path, plan.temporary_path);
	if (activation.placeholderActive) {
		await rename(plan.empty_placeholder_path, activation.path);
	}
	const removed = await safeRemoveTree(plan.temporary_path, activation.treeDigest);
	if (!removed) throw new Error("The copied destination changed and was preserved for manual recovery.");
}

async function stageFileRemoval(path, expectedDigest, stagedPath) {
	await assertPathAbsent(stagedPath, "Staged locator backup");
	const snapshot = await readFileWithDigest(path);
	if (snapshot.digest !== expectedDigest) {
		throw new PlanMismatchError("The external locator changed before activation.");
	}
	const before = await lstat(path);
	if (before.isSymbolicLink() || !before.isFile()) {
		throw new PlanMismatchError("The external locator is no longer a regular file.");
	}
	await rename(path, stagedPath);
	const after = await lstat(stagedPath);
	if (before.dev !== after.dev || before.ino !== after.ino) {
		throw migrationProblem("The external locator changed while it was being staged.", {
			locator_path: path,
		});
	}
	return {
		async rollback() {
			await assertPathAbsent(path, "External locator rollback destination");
			await rename(stagedPath, path);
		},
		async commit() {
			await unlink(stagedPath);
		},
	};
}

async function activateLocator(plan, identity) {
	const stagedPath = `${plan.locator.path}.migration-${calculatePlanDigest(plan).slice(0, 16)}.previous`;
	if (plan.destination.mode !== "external" && plan.source.mode !== "external") return null;
	if (plan.destination.mode !== "external") {
		return stageFileRemoval(plan.locator.path, plan.locator.digest, stagedPath);
	}

	const oldSnapshot = plan.locator.state === "present"
		? await readFileWithDigest(plan.locator.path)
		: null;
	if (oldSnapshot && oldSnapshot.digest !== plan.locator.digest) {
		throw new PlanMismatchError("The external locator changed before activation.");
	}
	const locator = {
		schema_version: 1,
		project_key: identity.projectKey,
		storage_path: plan.destination.selected_path,
		updated_at: plan.created_at,
	};
	const expectedWrittenDigest = sha256Hex(serializeExternalLocator(locator));
	let written;
	try {
		written = await writeExternalLocatorAtomically(
			plan.locator.path,
			locator,
			plan.locator.digest,
		);
	} catch (error) {
		if (error?.details?.committed === true) {
			try {
				const current = await readFileWithDigest(plan.locator.path);
				if (current.digest !== expectedWrittenDigest) {
					throw new Error("The committed locator does not match the intended migration locator.");
				}
				if (oldSnapshot) {
					await atomicWriteFile(plan.locator.path, oldSnapshot.data, {
						expectedDigest: current.digest,
						mode: 0o600,
					});
				} else {
					const staged = await stageFileRemoval(plan.locator.path, current.digest, stagedPath);
					await staged.commit();
				}
			} catch (rollbackError) {
				throw migrationProblem("Locator activation committed but could not be rolled back safely.", {
					locator_path: plan.locator.path,
				}, rollbackError);
			}
		}
		throw error;
	}
	return {
		async rollback() {
			if (oldSnapshot) {
				await atomicWriteFile(plan.locator.path, oldSnapshot.data, {
					expectedDigest: written.digest,
					mode: 0o600,
				});
				return;
			}
			const staged = await stageFileRemoval(plan.locator.path, written.digest, stagedPath);
			await staged.commit();
		},
		async commit() {},
	};
}

function validateHooks(hooks) {
	if (hooks === undefined) return {};
	if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
		throw new ValidationError("migration hooks must be an object.");
	}
	for (const [name, hook] of Object.entries(hooks)) {
		if (typeof hook !== "function") throw new ValidationError(`Migration hook '${name}' must be a function.`);
	}
	return hooks;
}

async function runHook(hooks, name, details) {
	if (hooks[name]) await hooks[name](details);
}

export async function applyMigrationPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		lockOptions,
		copyTree = copyStorageTree,
		hooks: suppliedHooks,
	} = {},
) {
	validateReviewedPlan(plan, "migration");
	requirePlanAuthorization(plan, authorization);
	if (plan.disclaimer !== MIGRATION_DISCLAIMER) {
		throw new PlanMismatchError("The migration plan does not contain the required disclaimer.");
	}
	if (typeof copyTree !== "function") throw new ValidationError("copyTree must be a function.");
	const hooks = validateHooks(suppliedHooks);
	const normalizedHome = resolve(homeDirectory);
	const normalizedIdentity = assertPlanIdentity(plan, identity, normalizedHome);
	const expectedDestination = storagePathForMode(
		normalizedIdentity,
		plan.destination.mode,
		plan.destination.mode === "external" ? plan.destination.selected_path : undefined,
		normalizedHome,
	);
	if (expectedDestination !== plan.destination.selected_path) {
		throw new PlanMismatchError("The migration destination does not match its storage mode.");
	}
	const lockPaths = [
		operationLockPath(normalizedIdentity.projectKey, plan.source.effective_path, {
			homeDirectory: normalizedHome,
		}),
		operationLockPath(normalizedIdentity.projectKey, plan.destination.effective_path, {
			homeDirectory: normalizedHome,
		}),
	];
	await verifyReviewedMigrationState(plan, normalizedIdentity, normalizedHome);
	return withOperationLocks(lockPaths, async () => {
		await verifyReviewedMigrationState(plan, normalizedIdentity, normalizedHome);
		if (plan.action === "noop") {
			return {
				operation: "migration",
				changed: false,
				action: "noop",
				mode: plan.destination.mode,
				storage_path: plan.destination.selected_path,
			};
		}
		await ensureDestinationParent(plan.destination);
		await assertPathAbsent(plan.temporary_path, "Migration temporary destination");
		await assertPathAbsent(plan.empty_placeholder_path, "Migration empty-directory placeholder");
		await assertPathAbsent(plan.backup_path, "Migration backup destination");

		let activation;
		let locatorTransaction;
		let sourceBackedUp = false;
		let copiedTreeDigest;
		const rollbackErrors = [];
		try {
			await runHook(hooks, "beforeCopy", { plan });
			await copyTree(plan.source.effective_path, plan.temporary_path);
			await runHook(hooks, "afterCopy", { plan });
			const comparison = await compareStorageTrees(
				plan.source.effective_path,
				plan.temporary_path,
			);
			copiedTreeDigest = comparison.digest;
			await validateStorageManifests(plan.temporary_path, normalizedIdentity);
			await runHook(hooks, "afterVerification", { plan, treeDigest: copiedTreeDigest });
			activation = await activateCopiedDestination(plan, copiedTreeDigest);
			await runHook(hooks, "afterDestinationActivation", { plan });
			await runHook(hooks, "beforeLocatorActivation", { plan });
			locatorTransaction = await activateLocator(plan, normalizedIdentity);
			await runHook(hooks, "afterLocatorActivation", { plan });
			await rename(plan.source.effective_path, plan.backup_path);
			sourceBackedUp = true;
			await runHook(hooks, "afterSourceBackup", { plan });

			const active = await resolveActiveStorage(normalizedIdentity, { homeDirectory: normalizedHome });
			if (active.mode !== plan.destination.mode || active.path !== plan.destination.selected_path) {
				throw new Error("The migrated destination did not become the sole active storage root.");
			}
		} catch (error) {
			if (sourceBackedUp) {
				try {
					await rename(plan.backup_path, plan.source.effective_path);
					sourceBackedUp = false;
				} catch (rollbackError) {
					rollbackErrors.push(`source restore: ${rollbackError.message}`);
				}
			}
			if (locatorTransaction) {
				try {
					await locatorTransaction.rollback();
				} catch (rollbackError) {
					rollbackErrors.push(`locator restore: ${rollbackError.message}`);
				}
			}
			if (activation) {
				try {
					await rollbackDestination(plan, activation);
					activation = undefined;
				} catch (rollbackError) {
					rollbackErrors.push(`destination restore: ${rollbackError.message}`);
				}
			} else if (copiedTreeDigest) {
				const removed = await safeRemoveTree(plan.temporary_path, copiedTreeDigest);
				if (!removed) rollbackErrors.push("temporary copy changed and was preserved");
			} else {
				try {
					await lstat(plan.temporary_path);
					rollbackErrors.push("unverified temporary destination was preserved for manual recovery");
				} catch (temporaryError) {
					if (temporaryError?.code !== "ENOENT") {
						rollbackErrors.push(`temporary destination inspection: ${temporaryError.message}`);
					}
				}
			}

			let sourceActive = false;
			try {
				const active = await resolveActiveStorage(normalizedIdentity, { homeDirectory: normalizedHome });
				const activeTreeDigest = storageTreeDigest(await treeSnapshot(active.effectivePath));
				sourceActive = sourceMatches(plan.source, active) && activeTreeDigest === plan.source.tree_digest;
			} catch (verificationError) {
				rollbackErrors.push(`active-source verification: ${verificationError.message}`);
			}
			throw migrationProblem(
				sourceActive
					? "Migration failed; the original storage root remains active."
					: "Migration failed and automatic rollback could not prove the original storage root active.",
				{
					source_active: sourceActive,
					source_path: plan.source.selected_path,
					destination_path: plan.destination.selected_path,
					rollback_errors: rollbackErrors,
				},
				error,
			);
		}

		const cleanupWarnings = [];
		try {
			await locatorTransaction?.commit();
		} catch (error) {
			cleanupWarnings.push(`staged locator cleanup: ${error.message}`);
		}
		if (activation?.placeholderActive) {
			try {
				await rmdir(plan.empty_placeholder_path);
			} catch (error) {
				cleanupWarnings.push(`empty destination placeholder cleanup: ${error.message}`);
			}
		}
		return {
			operation: "migration",
			changed: true,
			action: "migrate",
			mode: plan.destination.mode,
			storage_path: plan.destination.selected_path,
			effective_path: plan.destination.effective_path,
			backup_path: plan.backup_path,
			tree_digest: copiedTreeDigest,
			git_changes: plan.git_changes,
			cleanup_warnings: cleanupWarnings,
		};
	}, lockOptions);
}
