import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	ERROR_CODES,
	LocatorError,
	StorageResolutionError,
	ValidationError,
	validationIssue,
	throwIfValidationIssues,
} from "./errors.mjs";
import { readFileWithDigest } from "./filesystem.mjs";
import {
	isRfc3339UtcTimestamp,
	readExternalLocator,
} from "./locators.mjs";
import {
	deriveProjectKey,
	parseProjectKey,
	validateObjectId,
} from "./git-identity.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

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

function rootManifestIssues(metadata, expectedIdentity) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (metadata.artifact !== "project") {
		add(["artifact"], "invalid_artifact", "Root manifest artifact must be 'project'.");
	}
	if (metadata.schema_version !== 1) {
		add(["schema_version"], "unsupported_schema_version", "Root manifest schema_version must be 1.");
	}

	let keyIdentity;
	try {
		keyIdentity = parseProjectKey(metadata.project_key);
	} catch {
		add(
			["project_key"],
			"invalid_project_key",
			"Root manifest project_key must contain a full supported root commit object ID.",
		);
	}
	if (typeof metadata.project_name !== "string" || metadata.project_name.trim().length === 0) {
		add(["project_name"], "invalid_project_name", "Root manifest project_name must be a non-empty string.");
	}
	if (metadata.object_format !== "sha1" && metadata.object_format !== "sha256") {
		add(
			["object_format"],
			"invalid_object_format",
			"Root manifest object_format must be 'sha1' or 'sha256'.",
		);
	}
	try {
		validateObjectId(metadata.object_format, metadata.root_commit, { name: "Root manifest root_commit" });
	} catch {
		add(
			["root_commit"],
			"invalid_root_commit",
			"Root manifest root_commit must be a full object ID for object_format.",
		);
	}
	if (
		keyIdentity &&
		(metadata.object_format !== keyIdentity.objectFormat || metadata.root_commit !== keyIdentity.rootCommit)
	) {
		add(
			["project_key"],
			"inconsistent_project_identity",
			"Root manifest project_key, object_format, and root_commit must describe the same Git lineage.",
		);
	}
	if (!Number.isSafeInteger(metadata.next_workflow_number) || metadata.next_workflow_number < 1) {
		add(
			["next_workflow_number"],
			"invalid_counter",
			"Root manifest next_workflow_number must be a positive safe integer.",
		);
	}
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) {
			add([field], "invalid_timestamp", `Root manifest ${field} must be an RFC 3339 UTC timestamp.`);
		}
	}
	if (expectedIdentity !== undefined) {
		if (metadata.project_key !== expectedIdentity.projectKey) {
			add(
				["project_key"],
				"foreign_project_lineage",
				"Root manifest belongs to a different Git lineage.",
				{
					expected_project_key: expectedIdentity.projectKey,
					actual_project_key: metadata.project_key,
				},
			);
		}
		if (metadata.object_format !== expectedIdentity.objectFormat) {
			add(
				["object_format"],
				"foreign_object_format",
				"Root manifest object_format does not match the current project.",
			);
		}
		if (metadata.root_commit !== expectedIdentity.rootCommit) {
			add(
				["root_commit"],
				"foreign_root_commit",
				"Root manifest root_commit does not match the current project.",
			);
		}
	}
	return issues;
}

export function parseRootManifest(source, { path, expectedIdentity } = {}) {
	const normalizedIdentity = expectedIdentity === undefined ? undefined : validateStorageIdentity(expectedIdentity);
	const parsed = parseFrontmatter(source, { path });
	throwIfValidationIssues(rootManifestIssues(parsed.data, normalizedIdentity), {
		artifact: ROOT_MANIFEST_NAME,
		path,
	});
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
