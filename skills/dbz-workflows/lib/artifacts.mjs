import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	PlanMismatchError,
	ValidationError,
} from "./errors.mjs";
import {
	resolveWithinRoot,
	withLocalMutationLock,
} from "./filesystem.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import {
	operationLockPath,
	prepareOperationLock,
} from "./setup.mjs";
import {
	resolveActiveStorage,
	validateStorageIdentity,
} from "./storage.mjs";
import { inspectWorkflow } from "./workflows.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function canonicalTimestamp(clock = () => new Date()) {
	if (typeof clock !== "function") throw new ValidationError("clock must be a function.");
	const value = clock();
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError("clock must return a valid timestamp.");
	return date.toISOString();
}

export function requireArtifactDigest(value, name = "expectedDigest") {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new ValidationError(`${name} must be a lowercase SHA-256 digest returned by artifact inspection.`);
	}
	return value;
}

export function storageDescriptor(storage) {
	return {
		mode: storage.mode,
		path: storage.path,
		effective_path: storage.effectivePath,
	};
}

function identityDescriptor(identity) {
	return {
		project_root: identity.projectRoot,
		project_key: identity.projectKey,
		object_format: identity.objectFormat,
		root_commit: identity.rootCommit,
	};
}

function assertIdentity(expected, actual) {
	const left = identityDescriptor(expected);
	const right = identityDescriptor(actual);
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		throw new PlanMismatchError("The artifact operation does not match the current Git project identity.", {
			details: { expected: left, actual: right },
		});
	}
}

export async function resolveWorkflowArtifactContext(
	identity,
	workflowId,
	{ homeDirectory = homedir() } = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const actualIdentity = await inspectGitProject(normalizedIdentity.projectRoot);
	assertIdentity(normalizedIdentity, actualIdentity);
	const storage = await resolveActiveStorage(actualIdentity, { homeDirectory: normalizedHome });
	const workflow = await inspectWorkflow(actualIdentity, workflowId, { homeDirectory: normalizedHome });
	const directory = workflow.directory;
	return {
		identity: actualIdentity,
		homeDirectory: normalizedHome,
		storage,
		workflow,
		paths: {
			spec: resolveWithinRoot(directory, "spec.md"),
			verification: resolveWithinRoot(directory, "verification.md"),
			baselines: resolveWithinRoot(directory, "baselines"),
			decisions: resolveWithinRoot(directory, "decisions"),
			tickets: resolveWithinRoot(directory, "tickets"),
		},
	};
}

export async function withWorkflowArtifactLock(
	identity,
	workflowId,
	callback,
	{ homeDirectory = homedir(), lockOptions } = {},
) {
	if (typeof callback !== "function") throw new ValidationError("Artifact lock callback must be a function.");
	const before = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	const expectedStorage = storageDescriptor(before.storage);
	const lockPath = operationLockPath(before.identity.projectKey, before.storage.effectivePath, {
		homeDirectory: before.homeDirectory,
	});
	await prepareOperationLock(lockPath);
	return withLocalMutationLock(lockPath, async () => {
		const current = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
		if (JSON.stringify(storageDescriptor(current.storage)) !== JSON.stringify(expectedStorage)) {
			throw new PlanMismatchError("Active workflow storage changed before the artifact mutation acquired its lock.");
		}
		return callback(current);
	}, lockOptions);
}

export function canonicalArtifactFileMode(storage) {
	return storage.mode === "project" ? 0o644 : 0o600;
}
