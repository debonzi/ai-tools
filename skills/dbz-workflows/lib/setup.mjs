import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	realpath,
	rmdir,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	normalize,
	relative,
	resolve,
} from "node:path";
import {
	ConfirmationRequiredError,
	ERROR_CODES,
	PlanMismatchError,
	SetupError,
	StorageResolutionError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	sha256Hex,
	withLocalMutationLock,
} from "./filesystem.mjs";
import { serializeFrontmatter } from "./frontmatter.mjs";
import {
	parseExternalLocator,
	serializeExternalLocator,
} from "./locators.mjs";
import {
	externalLocatorPath,
	inspectStorageCandidates,
	lineageNoticeForStorageMode,
	managedStoragePath,
	parseRootManifest,
	projectStoragePath,
	ROOT_MANIFEST_NAME,
	STORAGE_MODES,
	validateStorageIdentity,
} from "./storage.mjs";

export const SETUP_PLAN_VERSION = 1;
export const ROOT_MANIFEST_BODY = [
	"# DBZ Workflows",
	"",
	"This directory is managed by DBZ Workflows. Direct metadata edits may fail validation.",
	"",
].join("\n");

function setupProblem(message, details, cause) {
	return new SetupError(message, {
		details,
		...(cause === undefined ? {} : { cause }),
	});
}

function assertPlainObject(value, name) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${name} must be an object.`);
	}
}

function normalizedTimestamp(value, name = "timestamp") {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new ValidationError(`${name} must identify a valid timestamp.`);
	}
	return date.toISOString();
}

function planTimestamp(clock) {
	if (typeof clock !== "function") throw new ValidationError("clock must be a function.");
	return normalizedTimestamp(clock(), "clock result");
}

function normalizeProjectName(projectName, projectRoot) {
	const value = projectName ?? basename(projectRoot);
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("projectName must be a non-empty single-line string without NUL bytes.");
	}
	return value.trim();
}

export function normalizeExternalStoragePath(storagePath) {
	if (
		typeof storagePath !== "string" ||
		storagePath.length === 0 ||
		storagePath.includes("\0") ||
		!isAbsolute(storagePath)
	) {
		throw new ValidationError("External storage path must be a non-empty absolute path without NUL bytes.");
	}
	if (normalize(storagePath) !== storagePath) {
		throw new ValidationError("External storage path must not contain traversal or redundant segments.");
	}
	return storagePath;
}

export function storagePathForMode(identity, mode, externalPath, homeDirectory) {
	if (!STORAGE_MODES.includes(mode)) {
		throw new ValidationError("Storage mode must be 'project', 'managed', or 'external'.");
	}
	if (mode === "project") {
		if (externalPath !== undefined) {
			throw new ValidationError("externalPath is valid only for external storage mode.");
		}
		return projectStoragePath(identity.projectRoot);
	}
	if (mode === "managed") {
		if (externalPath !== undefined) {
			throw new ValidationError("externalPath is valid only for external storage mode.");
		}
		return managedStoragePath(identity.projectKey, { homeDirectory });
	}
	if (externalPath === undefined) {
		throw new ValidationError("External storage mode requires the exact externalPath selected by the user.");
	}
	return normalizeExternalStoragePath(externalPath);
}

async function nearestExistingDirectory(selectedPath, { allowTargetSymlink }) {
	let cursor = selectedPath;
	const missingSegments = [];
	while (true) {
		let entry;
		try {
			entry = await lstat(cursor);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			missingSegments.unshift(basename(cursor));
			cursor = parent;
			continue;
		}

		const isTarget = missingSegments.length === 0;
		if (isTarget && entry.isSymbolicLink() && !allowTargetSymlink) {
			throw setupProblem("The selected fixed storage root must not be a symbolic link.", {
				storage_path: selectedPath,
			});
		}
		let effectiveBase;
		try {
			effectiveBase = await realpath(cursor);
			const effectiveEntry = await stat(effectiveBase);
			if (!effectiveEntry.isDirectory()) {
				throw new Error("The existing path component does not resolve to a directory.");
			}
		} catch (error) {
			throw setupProblem("A storage destination path component is not a usable directory.", {
				storage_path: selectedPath,
				path_component: cursor,
			}, error);
		}
		return {
			exists: isTarget,
			selectedKind: isTarget ? (entry.isSymbolicLink() ? "symlink" : "directory") : "missing",
			effectivePath: resolve(effectiveBase, ...missingSegments),
			nearestExistingPath: cursor,
			nearestEffectivePath: effectiveBase,
		};
	}
}

export async function inspectSetupDestination(mode, selectedPath, identity) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const path = mode === "external"
		? normalizeExternalStoragePath(selectedPath)
		: resolve(selectedPath);
	const location = await nearestExistingDirectory(path, {
		allowTargetSymlink: mode === "external",
	});
	if (!location.exists) {
		return {
			selected_path: path,
			effective_path: location.effectivePath,
			selected_kind: "missing",
			state: "missing",
			manifest_digest: null,
		};
	}

	let names;
	try {
		names = (await readdir(location.effectivePath)).sort();
	} catch (error) {
		throw setupProblem("The selected storage destination cannot be read safely.", {
			storage_path: path,
			effective_path: location.effectivePath,
		}, error);
	}
	if (!names.includes(ROOT_MANIFEST_NAME)) {
		if (names.length === 0) {
			return {
				selected_path: path,
				effective_path: location.effectivePath,
				selected_kind: location.selectedKind,
				state: "empty",
				manifest_digest: null,
			};
		}
		throw setupProblem(
			"The selected storage destination is non-empty and has no valid DBZ Workflows root manifest.",
			{
				storage_path: path,
				effective_path: location.effectivePath,
				entries: names,
			},
		);
	}

	const manifestPath = resolve(location.effectivePath, ROOT_MANIFEST_NAME);
	let snapshot;
	try {
		snapshot = await readFileWithDigest(manifestPath, { encoding: "utf8" });
		parseRootManifest(snapshot.data, {
			path: manifestPath,
			expectedIdentity: normalizedIdentity,
		});
	} catch (error) {
		throw setupProblem(
			"The selected storage destination contains an invalid or foreign root manifest; it will not be repaired or overwritten.",
			{ storage_path: path, effective_path: location.effectivePath },
			error,
		);
	}
	return {
		selected_path: path,
		effective_path: location.effectivePath,
		selected_kind: location.selectedKind,
		state: "adoptable",
		manifest_digest: snapshot.digest,
	};
}

export async function assertExternalDestinationIsDistinct(
	destination,
	identity,
	{ homeDirectory = homedir() } = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	for (const [mode, fixedPath] of [
		["project", projectStoragePath(normalizedIdentity.projectRoot)],
		["managed", managedStoragePath(normalizedIdentity.projectKey, { homeDirectory })],
	]) {
		const fixedLocation = await nearestExistingDirectory(fixedPath, { allowTargetSymlink: false });
		if (destination.effective_path === fixedLocation.effectivePath) {
			throw setupProblem(
				"External storage must not resolve to a fixed project or managed storage path, because that would activate two modes.",
				{
					external_path: destination.selected_path,
					effective_path: destination.effective_path,
					conflicting_mode: mode,
					conflicting_path: fixedPath,
				},
			);
		}
	}
}

export async function inspectLocatorState(path, projectKey) {
	let entry;
	try {
		entry = await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return { path, state: "missing", digest: null };
		throw setupProblem("The external locator cannot be inspected safely.", { locator_path: path }, error);
	}
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw setupProblem("The external locator path must be a regular file and must not be a symbolic link.", {
			locator_path: path,
		});
	}
	let snapshot;
	try {
		snapshot = await readFileWithDigest(path, { encoding: "utf8" });
		const locator = parseExternalLocator(snapshot.data, { path, expectedProjectKey: projectKey });
		return { path, state: "present", digest: snapshot.digest, locator };
	} catch (error) {
		throw setupProblem("The external locator is invalid and requires explicit reconfiguration.", {
			locator_path: path,
		}, error);
	}
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function calculatePlanDigest(plan) {
	assertPlainObject(plan, "plan");
	const unsigned = { ...plan };
	delete unsigned.plan_digest;
	return sha256Hex(`${JSON.stringify(canonicalize(unsigned))}\n`);
}

export function finalizePlan(plan) {
	return { ...plan, plan_digest: calculatePlanDigest(plan) };
}

export function validateReviewedPlan(plan, operation) {
	assertPlainObject(plan, "plan");
	if (plan.plan_version !== SETUP_PLAN_VERSION || plan.operation !== operation) {
		throw new PlanMismatchError(`Expected a version ${SETUP_PLAN_VERSION} '${operation}' plan.`);
	}
	const actualDigest = calculatePlanDigest(plan);
	if (typeof plan.plan_digest !== "string" || plan.plan_digest !== actualDigest) {
		throw new PlanMismatchError("The plan content does not match its recorded digest.", {
			details: { recorded_digest: plan.plan_digest, actual_digest: actualDigest },
		});
	}
	return plan;
}

export function requirePlanAuthorization(plan, authorization) {
	if (
		authorization?.confirmed !== true ||
		typeof authorization?.planDigest !== "string" ||
		authorization.planDigest !== plan.plan_digest
	) {
		throw new ConfirmationRequiredError(
			"Apply requires explicit authorization tied to the exact reviewed plan digest.",
			{ details: { plan_digest: plan.plan_digest } },
		);
	}
}

function manifestSource(identity, projectName, timestamp) {
	return serializeFrontmatter(
		{
			artifact: "project",
			schema_version: 1,
			project_key: identity.projectKey,
			project_name: projectName,
			object_format: identity.objectFormat,
			root_commit: identity.rootCommit,
			next_workflow_number: 1,
			created_at: timestamp,
			updated_at: timestamp,
		},
		ROOT_MANIFEST_BODY,
	);
}

function planIdentity(identity) {
	return {
		project_root: identity.projectRoot,
		object_format: identity.objectFormat,
		root_commit: identity.rootCommit,
		project_key: identity.projectKey,
	};
}

export function assertPlanIdentity(plan, identity, homeDirectory) {
	const current = validateStorageIdentity(identity);
	const expected = plan.identity;
	if (
		expected?.project_root !== current.projectRoot ||
		expected?.object_format !== current.objectFormat ||
		expected?.root_commit !== current.rootCommit ||
		expected?.project_key !== current.projectKey
	) {
		throw new PlanMismatchError("The reviewed plan does not match the current Git project identity.", {
			details: { expected, actual: planIdentity(current) },
		});
	}
	if (plan.home_directory !== resolve(homeDirectory)) {
		throw new PlanMismatchError("The reviewed plan was created for a different home directory.", {
			details: { expected_home: plan.home_directory, actual_home: resolve(homeDirectory) },
		});
	}
	return current;
}

function activeCandidates(inspected) {
	return inspected.candidates.filter(({ status }) => status === "valid");
}

function isRequestedActive(active, mode, selectedPath) {
	return active.mode === mode && active.path === selectedPath;
}

export async function createSetupPlan(
	identity,
	{
		mode,
		externalPath,
		projectName,
		homeDirectory = homedir(),
		clock = () => new Date(),
	} = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const selectedPath = storagePathForMode(
		normalizedIdentity,
		mode,
		externalPath,
		normalizedHome,
	);
	const name = normalizeProjectName(projectName, normalizedIdentity.projectRoot);
	const createdAt = planTimestamp(clock);
	const inspected = await inspectStorageCandidates(normalizedIdentity, {
		homeDirectory: normalizedHome,
	});
	const active = activeCandidates(inspected);
	if (active.length > 1) {
		throw new StorageResolutionError(
			"Multiple DBZ Workflows storage roots are active. Select and resolve them through explicit reconfiguration.",
			{
				code: ERROR_CODES.STORAGE_AMBIGUOUS,
				details: { candidates: active.map(({ mode: activeMode, path }) => ({ mode: activeMode, path })) },
			},
		);
	}
	if (active.length === 1 && !isRequestedActive(active[0], mode, selectedPath)) {
		throw setupProblem(
			"DBZ Workflows is already configured in another storage location. Create and apply a migration plan to reconfigure it.",
			{
				active_mode: active[0].mode,
				active_path: active[0].path,
				requested_mode: mode,
				requested_path: selectedPath,
			},
		);
	}

	const destination = await inspectSetupDestination(mode, selectedPath, normalizedIdentity);
	if (mode === "external") {
		await assertExternalDestinationIsDistinct(destination, normalizedIdentity, {
			homeDirectory: normalizedHome,
		});
	}
	const locatorPath = externalLocatorPath(normalizedIdentity.projectKey, {
		homeDirectory: normalizedHome,
	});
	const locator = await inspectLocatorState(locatorPath, normalizedIdentity.projectKey);
	let action;
	if (active.length === 1) {
		action = "noop";
	} else if (destination.state === "missing") {
		action = "create";
	} else if (destination.state === "empty") {
		action = "initialize";
	} else {
		action = mode === "external" ? "adopt" : "noop";
	}
	if (mode === "external" && action !== "noop" && locator.state !== "missing") {
		throw setupProblem("External setup cannot replace an existing locator outside explicit migration.", {
			locator_path: locator.path,
		});
	}

	const createsManifest = action === "create" || action === "initialize";
	const writesLocator = mode === "external" && action !== "noop";
	const rootManifest = createsManifest
		? manifestSource(normalizedIdentity, name, createdAt)
		: null;
	if (rootManifest !== null) {
		parseRootManifest(rootManifest, { expectedIdentity: normalizedIdentity });
	}
	return finalizePlan({
		operation: "setup",
		plan_version: SETUP_PLAN_VERSION,
		created_at: createdAt,
		identity: planIdentity(normalizedIdentity),
		home_directory: normalizedHome,
		mode,
		project_name: name,
		action,
		destination,
		locator: {
			path: locator.path,
			state: locator.state,
			digest: locator.digest,
			...(locator.locator === undefined ? {} : { storage_path: locator.locator.storage_path }),
		},
		root_manifest: rootManifest,
		lineage_notice: lineageNoticeForStorageMode(mode),
		changes: [
			...(createsManifest
				? [{ action: "create_root_manifest", path: resolve(destination.effective_path, ROOT_MANIFEST_NAME) }]
				: []),
			...(writesLocator ? [{ action: "write_external_locator", path: locator.path }] : []),
		],
		git_changes: mode === "project" && createsManifest
			? [{ change: "created", path: relative(normalizedIdentity.projectRoot, resolve(destination.effective_path, ROOT_MANIFEST_NAME)) }]
			: [],
	});
}

function destinationsMatch(expected, actual) {
	return (
		expected.selected_path === actual.selected_path &&
		expected.effective_path === actual.effective_path &&
		expected.selected_kind === actual.selected_kind &&
		expected.state === actual.state &&
		expected.manifest_digest === actual.manifest_digest
	);
}

export function operationalStateRoot({ homeDirectory = homedir() } = {}) {
	return resolve(homeDirectory, ".local", "state", "dbz-workflows");
}

export function operationLockPath(projectKey, canonicalStoragePath, options = {}) {
	const stateRoot = operationalStateRoot(options);
	const pathDigest = sha256Hex(resolve(canonicalStoragePath));
	return resolve(stateRoot, "locks", projectKey, `${pathDigest}.lock`);
}

async function ensureDirectory(path, { mode = 0o700, rejectTargetSymlink = true } = {}) {
	let entry;
	try {
		entry = await lstat(path);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(path, { recursive: true, mode });
		entry = await lstat(path);
	}
	if ((rejectTargetSymlink && entry.isSymbolicLink()) || !entry.isDirectory()) {
		throw setupProblem("A required directory path is not a safe directory.", { path });
	}
	return path;
}

export async function prepareOperationLock(lockPath) {
	await ensureDirectory(dirname(lockPath), { mode: 0o700 });
	return lockPath;
}

async function ensureStorageDirectory(destination, mode) {
	if (destination.state !== "missing") return { created: false };
	const directoryMode = mode === "project" ? 0o755 : 0o700;
	await mkdir(destination.effective_path, { recursive: true, mode: directoryMode });
	const entry = await lstat(destination.effective_path);
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw setupProblem("The storage root was not created as a regular directory.", {
			storage_path: destination.selected_path,
			effective_path: destination.effective_path,
		});
	}
	return { created: true };
}

async function removeOwnedFile(path, expectedDigest) {
	let snapshot;
	try {
		snapshot = await readFileWithDigest(path);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (snapshot.digest !== expectedDigest) return false;
	await unlink(path);
	return true;
}

export async function writeExternalLocatorAtomically(path, locator, expectedDigest) {
	await ensureDirectory(dirname(path), { mode: 0o700 });
	return atomicWriteFile(path, serializeExternalLocator(locator), {
		expectedDigest,
		mode: 0o600,
	});
}

function locatorMatches(expected, actual) {
	return expected.path === actual.path && expected.state === actual.state && expected.digest === actual.digest;
}

async function assertNoCompetingActiveStorage(identity, plan, homeDirectory) {
	const inspected = await inspectStorageCandidates(identity, { homeDirectory });
	const active = activeCandidates(inspected);
	if (plan.action === "noop") {
		if (active.length !== 1 || !isRequestedActive(active[0], plan.mode, plan.destination.selected_path)) {
			throw new PlanMismatchError("The active storage changed after the setup plan was reviewed.");
		}
		return;
	}
	if (active.length !== 0) {
		throw new PlanMismatchError("Another storage root became active after the setup plan was reviewed.", {
			details: { candidates: active.map(({ mode, path }) => ({ mode, path })) },
		});
	}
}

async function verifySetupPlanState(plan, identity, homeDirectory) {
	try {
		await assertNoCompetingActiveStorage(identity, plan, homeDirectory);
	} catch (error) {
		if (error instanceof PlanMismatchError) throw error;
		throw new PlanMismatchError("Storage candidate state changed after the setup plan was reviewed.", {
			cause: error,
		});
	}
	let currentDestination;
	try {
		currentDestination = await inspectSetupDestination(
			plan.mode,
			plan.destination.selected_path,
			identity,
		);
	} catch (error) {
		throw new PlanMismatchError("The storage destination changed after the setup plan was reviewed.", {
			cause: error,
		});
	}
	if (plan.mode === "external") {
		await assertExternalDestinationIsDistinct(currentDestination, identity, { homeDirectory });
	}
	if (!destinationsMatch(plan.destination, currentDestination)) {
		throw new PlanMismatchError("The storage destination changed after the setup plan was reviewed.", {
			details: { expected: plan.destination, actual: currentDestination },
		});
	}
	let currentLocator;
	try {
		currentLocator = await inspectLocatorState(plan.locator.path, identity.projectKey);
	} catch (error) {
		throw new PlanMismatchError("The external locator changed after the setup plan was reviewed.", {
			cause: error,
		});
	}
	if (!locatorMatches(plan.locator, currentLocator)) {
		throw new PlanMismatchError("The external locator changed after the setup plan was reviewed.");
	}
}

export async function applySetupPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		lockOptions,
	} = {},
) {
	validateReviewedPlan(plan, "setup");
	requirePlanAuthorization(plan, authorization);
	const normalizedHome = resolve(homeDirectory);
	const normalizedIdentity = assertPlanIdentity(plan, identity, normalizedHome);
	const expectedPath = storagePathForMode(
		normalizedIdentity,
		plan.mode,
		plan.mode === "external" ? plan.destination.selected_path : undefined,
		normalizedHome,
	);
	if (expectedPath !== plan.destination.selected_path) {
		throw new PlanMismatchError("The setup destination does not match the selected storage mode.");
	}
	const lockPath = operationLockPath(
		normalizedIdentity.projectKey,
		plan.destination.effective_path,
		{ homeDirectory: normalizedHome },
	);
	await verifySetupPlanState(plan, normalizedIdentity, normalizedHome);
	await prepareOperationLock(lockPath);
	return withLocalMutationLock(lockPath, async () => {
		await verifySetupPlanState(plan, normalizedIdentity, normalizedHome);
		if (plan.action === "noop") {
			return {
				operation: "setup",
				changed: false,
				action: "noop",
				mode: plan.mode,
				storage_path: plan.destination.selected_path,
				effective_path: plan.destination.effective_path,
				git_changes: [],
			};
		}

		let createdDirectory = false;
		let manifestDigestToCleanup;
		let locatorDigestToCleanup;
		const locatorRecord = plan.mode === "external"
			? {
				schema_version: 1,
				project_key: normalizedIdentity.projectKey,
				storage_path: plan.destination.selected_path,
				updated_at: plan.created_at,
			}
			: null;
		try {
			if (plan.action === "create" || plan.action === "initialize") {
				({ created: createdDirectory } = await ensureStorageDirectory(plan.destination, plan.mode));
				const manifestPath = resolve(plan.destination.effective_path, ROOT_MANIFEST_NAME);
				try {
					const manifestWrite = await atomicWriteFile(manifestPath, plan.root_manifest, {
						expectedDigest: null,
						mode: plan.mode === "project" ? 0o644 : 0o600,
						root: plan.destination.effective_path,
					});
					manifestDigestToCleanup = manifestWrite.digest;
				} catch (error) {
					if (error?.details?.committed === true) {
						manifestDigestToCleanup = sha256Hex(plan.root_manifest);
					}
					throw error;
				}
				parseRootManifest(plan.root_manifest, {
					path: manifestPath,
					expectedIdentity: normalizedIdentity,
				});
			}
			if (locatorRecord) {
				try {
					const locatorWrite = await writeExternalLocatorAtomically(
						plan.locator.path,
						locatorRecord,
						plan.locator.digest,
					);
					locatorDigestToCleanup = locatorWrite.digest;
				} catch (error) {
					if (error?.details?.committed === true) {
						locatorDigestToCleanup = sha256Hex(serializeExternalLocator(locatorRecord));
					}
					throw error;
				}
			}
			const verified = await inspectSetupDestination(
				plan.mode,
				plan.destination.selected_path,
				normalizedIdentity,
			);
			if (verified.state !== "adoptable") {
				throw setupProblem("Setup did not produce a valid storage root.", {
					storage_path: plan.destination.selected_path,
				});
			}
			return {
				operation: "setup",
				changed: true,
				action: plan.action,
				mode: plan.mode,
				storage_path: plan.destination.selected_path,
				effective_path: plan.destination.effective_path,
				manifest_digest: verified.manifest_digest,
				locator_path: plan.mode === "external" ? plan.locator.path : null,
				git_changes: plan.git_changes,
			};
		} catch (error) {
			if (locatorDigestToCleanup) {
				await removeOwnedFile(plan.locator.path, locatorDigestToCleanup).catch(() => false);
			}
			if (manifestDigestToCleanup) {
				const manifestPath = resolve(plan.destination.effective_path, ROOT_MANIFEST_NAME);
				await removeOwnedFile(manifestPath, manifestDigestToCleanup).catch(() => false);
			}
			if (createdDirectory) await rmdir(plan.destination.effective_path).catch(() => {});
			throw error;
		}
	}, lockOptions);
}

export function migrationTemporaryName(storagePath, token = randomUUID()) {
	return `.${basename(storagePath)}.dbz-workflows-migration-${token}.tmp`;
}
