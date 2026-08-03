import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	ERROR_CODES,
	LocatorError,
	StorageResolutionError,
	ValidationError,
} from "./errors.mjs";
import { readFileWithDigest } from "./filesystem.mjs";
import { readExternalLocator } from "./locators.mjs";
import {
	deriveProjectKey,
	parseProjectKey,
	validateObjectId,
} from "./git-identity.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { validateProjectMetadata } from "./schemas/project.mjs";

export const STORAGE_MODES = Object.freeze(["project", "managed", "external"]);
export const ROOT_MANIFEST_NAME = "dbz-workflows.md";
export const SHARED_LINEAGE_NOTICE =
	"This project is identified by its root Git commit. Clones, worktrees, and forks that share this history will use the same workflow storage.";

function assertAbsolutePath(path, name) {
	if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
		throw new ValidationError(`${name} must be an absolute path without NUL bytes.`);
	}
	return resolve(path);
}

function validatedProjectKey(projectKey) {
	parseProjectKey(projectKey);
	return projectKey;
}

export function validateStorageIdentity(identity) {
	if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
		throw new ValidationError("Git project identity must be an object.");
	}
	const projectRoot = assertAbsolutePath(identity.projectRoot, "identity.projectRoot");
	validateObjectId(identity.objectFormat, identity.rootCommit, { name: "Identity root commit" });
	const expectedKey = deriveProjectKey(identity.objectFormat, identity.rootCommit);
	if (identity.projectKey !== expectedKey) {
		throw new ValidationError("Git project identity contains an inconsistent project key.", {
			details: { expected_project_key: expectedKey, actual_project_key: identity.projectKey },
		});
	}
	return {
		...identity,
		projectRoot,
		projectKey: expectedKey,
	};
}

export function projectStoragePath(projectRoot) {
	return resolve(assertAbsolutePath(projectRoot, "projectRoot"), "dbz-workflows");
}

export function managedStoragePath(projectKey, { homeDirectory = homedir() } = {}) {
	validatedProjectKey(projectKey);
	const home = assertAbsolutePath(homeDirectory, "homeDirectory");
	return resolve(home, ".local", "share", "dbz-workflows", "projects", projectKey);
}

export function externalLocatorPath(projectKey, { homeDirectory = homedir() } = {}) {
	validatedProjectKey(projectKey);
	const home = assertAbsolutePath(homeDirectory, "homeDirectory");
	return resolve(home, ".config", "dbz-workflows", "projects", `${projectKey}.json`);
}

export function storageCandidatePaths(identity, { homeDirectory = homedir() } = {}) {
	const normalized = validateStorageIdentity(identity);
	return {
		project: projectStoragePath(normalized.projectRoot),
		managed: managedStoragePath(normalized.projectKey, { homeDirectory }),
		externalLocator: externalLocatorPath(normalized.projectKey, { homeDirectory }),
	};
}

export function lineageNoticeForStorageMode(mode) {
	if (!STORAGE_MODES.includes(mode)) {
		throw new ValidationError("Storage mode must be 'project', 'managed', or 'external'.");
	}
	if (mode === "project") return null;
	return {
		id: "shared_git_lineage",
		message: SHARED_LINEAGE_NOTICE,
		required: true,
	};
}

export function parseRootManifest(source, { path, expectedIdentity } = {}) {
	const normalizedIdentity = expectedIdentity === undefined ? undefined : validateStorageIdentity(expectedIdentity);
	const parsed = parseFrontmatter(source, { path });
	validateProjectMetadata(parsed.data, { expectedIdentity: normalizedIdentity, path });
	return {
		metadata: parsed.data,
		body: parsed.body,
	};
}

function missingResult(mode, path, reason, extra = {}) {
	return {
		mode,
		path,
		status: "absent",
		reason,
		...extra,
	};
}

function invalidRoot(mode, path, message, cause) {
	return new StorageResolutionError(message, {
		code: ERROR_CODES.INVALID_STORAGE_ROOT,
		details: {
			mode,
			storage_path: path,
			...(cause === undefined
				? {}
				: {
					reason_code: typeof cause?.code === "string" ? cause.code : "invalid_storage_root",
					reason: cause instanceof Error ? cause.message : String(cause),
					...(cause?.details === undefined ? {} : { reason_details: cause.details }),
				}),
		},
		cause: cause instanceof Error ? cause : undefined,
	});
}

async function inspectRootDirectory(mode, path, identity, { allowRootSymlink, locator } = {}) {
	let initialEntry;
	try {
		initialEntry = await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return missingResult(mode, path, "storage_root_missing");
		throw invalidRoot(mode, path, `Cannot inspect ${mode} storage root safely.`, error);
	}

	let effectivePath;
	if (allowRootSymlink) {
		try {
			effectivePath = await realpath(path);
			const effectiveEntry = await stat(effectivePath);
			if (!effectiveEntry.isDirectory()) {
				throw new Error("The effective external storage path is not a directory.");
			}
		} catch (error) {
			throw invalidRoot(mode, path, "External storage path does not resolve to a directory.", error);
		}
	} else {
		if (initialEntry.isSymbolicLink() || !initialEntry.isDirectory()) {
			throw invalidRoot(
				mode,
				path,
				`${mode === "project" ? "Project" : "Managed"} storage root must be a directory and must not be a symbolic link.`,
			);
		}
		effectivePath = await realpath(path);
	}

	const manifestPath = resolve(path, ROOT_MANIFEST_NAME);
	let snapshot;
	try {
		snapshot = await readFileWithDigest(manifestPath, { encoding: "utf8" });
	} catch (error) {
		if (error?.code === "ENOENT") {
			return missingResult(mode, path, "root_manifest_missing", {
				effectivePath,
				rootExists: true,
			});
		}
		throw invalidRoot(mode, path, `Cannot read ${mode} root manifest safely.`, error);
	}

	try {
		const currentEffectivePath = await realpath(path);
		if (currentEffectivePath !== effectivePath) {
			throw new Error("Storage root resolved to a different path during inspection.");
		}
		if (!allowRootSymlink) {
			const currentEntry = await lstat(path);
			if (
				currentEntry.isSymbolicLink() ||
				!currentEntry.isDirectory() ||
				currentEntry.dev !== initialEntry.dev ||
				currentEntry.ino !== initialEntry.ino
			) {
				throw new Error("Storage root changed during inspection.");
			}
		}
	} catch (error) {
		throw invalidRoot(mode, path, `The ${mode} storage root changed during inspection.`, error);
	}

	let manifest;
	try {
		manifest = parseRootManifest(snapshot.data, {
			path: manifestPath,
			expectedIdentity: identity,
		});
	} catch (error) {
		throw invalidRoot(mode, path, `The ${mode} root manifest is invalid.`, error);
	}
	return {
		mode,
		path,
		effectivePath,
		status: "valid",
		manifestPath,
		manifestDigest: snapshot.digest,
		manifest: manifest.metadata,
		locator: locator ?? null,
		lineageNotice: lineageNoticeForStorageMode(mode),
	};
}

function brokenLocator(locatorPath, message, cause, details = {}) {
	return new LocatorError(message, {
		code: ERROR_CODES.BROKEN_LOCATOR,
		details: {
			locator_path: locatorPath,
			...details,
			...(cause === undefined
				? {}
				: {
					reason_code: typeof cause?.code === "string" ? cause.code : "broken_locator",
					reason: cause instanceof Error ? cause.message : String(cause),
					...(cause?.details === undefined ? {} : { reason_details: cause.details }),
				}),
		},
		cause: cause instanceof Error ? cause : undefined,
	});
}

export async function inspectStorageCandidates(identity, { homeDirectory = homedir() } = {}) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const paths = storageCandidatePaths(normalizedIdentity, { homeDirectory });
	const candidates = [];
	candidates.push(
		await inspectRootDirectory("project", paths.project, normalizedIdentity, {
			allowRootSymlink: false,
		}),
	);
	candidates.push(
		await inspectRootDirectory("managed", paths.managed, normalizedIdentity, {
			allowRootSymlink: false,
		}),
	);

	let locatorRecord;
	try {
		locatorRecord = await readExternalLocator(paths.externalLocator, {
			expectedProjectKey: normalizedIdentity.projectKey,
		});
	} catch (error) {
		if (error?.code === "ENOENT") {
			candidates.push(
				missingResult("external", null, "locator_missing", { locatorPath: paths.externalLocator }),
			);
			return { paths, candidates };
		}
		throw brokenLocator(
			paths.externalLocator,
			"External storage locator is broken; run explicit storage reconfiguration.",
			error,
		);
	}

	let externalCandidate;
	try {
		externalCandidate = await inspectRootDirectory(
			"external",
			locatorRecord.locator.storage_path,
			normalizedIdentity,
			{
				allowRootSymlink: true,
				locator: {
					path: locatorRecord.path,
					digest: locatorRecord.digest,
					updatedAt: locatorRecord.locator.updated_at,
				},
			},
		);
	} catch (error) {
		throw brokenLocator(
			paths.externalLocator,
			"External storage locator does not resolve to a valid storage root; run explicit storage reconfiguration.",
			error,
			{ storage_path: locatorRecord.locator.storage_path },
		);
	}
	if (externalCandidate.status !== "valid") {
		throw brokenLocator(
			paths.externalLocator,
			"External storage locator does not resolve to a valid storage root; run explicit storage reconfiguration.",
			undefined,
			{
				storage_path: locatorRecord.locator.storage_path,
				reason: externalCandidate.reason,
			},
		);
	}
	candidates.push(externalCandidate);
	return { paths, candidates };
}

export async function resolveActiveStorage(identity, options = {}) {
	const inspected = await inspectStorageCandidates(identity, options);
	const valid = inspected.candidates.filter((candidate) => candidate.status === "valid");
	if (valid.length === 0) {
		throw new StorageResolutionError(
			"DBZ Workflows is not configured for this project. Run project workflow setup before continuing.",
			{
				code: ERROR_CODES.STORAGE_SETUP_REQUIRED,
				details: {
					project_path: inspected.paths.project,
					managed_path: inspected.paths.managed,
					external_locator_path: inspected.paths.externalLocator,
				},
			},
		);
	}
	if (valid.length > 1) {
		throw new StorageResolutionError(
			"Multiple DBZ Workflows storage roots are active for this project. Reconfigure storage explicitly; no mode has precedence.",
			{
				code: ERROR_CODES.STORAGE_AMBIGUOUS,
				details: {
					candidates: valid.map(({ mode, path, effectivePath }) => ({
						mode,
						path,
						effective_path: effectivePath,
					})),
				},
			},
		);
	}
	return {
		...valid[0],
		projectKey: identity.projectKey,
		candidateStates: inspected.candidates.map(({ mode, path, status, reason }) => ({
			mode,
			path,
			status,
			...(reason === undefined ? {} : { reason }),
		})),
	};
}
