import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import {
	ERROR_CODES,
	PlanMismatchError,
	RevisionConflictError,
	ValidationError,
	WorkflowError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	resolveWithinRoot,
	sha256Hex,
	withLocalMutationLock,
} from "./filesystem.mjs";
import { parseFrontmatter, patchFrontmatter } from "./frontmatter.mjs";
import {
	inspectGitProject,
	runGit,
	validateObjectId,
} from "./git-identity.mjs";
import {
	assertCleanWorktree,
	assertValidLocalBranchName,
	isCommitAncestor,
	resolveLocalBranchCommit,
	validateImmutableSlug,
	validateWorkflowId,
	workflowBranchName,
} from "./git-operations.mjs";
import {
	applyWorkflowBranchPlan,
	createWorkflowBranchPlan,
	GIT_PLAN_OPERATIONS,
} from "./git-plans.mjs";
import { indexLevelTwoSections } from "./markdown.mjs";
import {
	finalizePlan,
	requirePlanAuthorization,
	validateReviewedPlan,
} from "./plans.mjs";
import {
	ISSUE_RELATIONS,
	WORKFLOW_CONDITIONS,
	WORKFLOW_PHASES,
	assertWorkflowConditions,
	assertWorkflowPhaseTransition,
	normalizeIssueLinks,
	validateWorkflowMetadata,
} from "./schemas/workflow.mjs";
import {
	operationLockPath,
	prepareOperationLock,
} from "./setup.mjs";
import {
	parseRootManifest,
	resolveActiveStorage,
	ROOT_MANIFEST_NAME,
	validateStorageIdentity,
} from "./storage.mjs";
import {
	createInitialSpecArtifactSource,
	createWorkflowArtifactSource,
} from "./templates/workflow.mjs";

export const WORKFLOW_PLAN_OPERATIONS = Object.freeze({
	RESERVATION: "workflow_id_reservation",
	START: "workflow_start",
});
export const WORKFLOW_DIRECTORY_NAMES = Object.freeze({
	baselines: "baselines",
	decisions: "decisions",
	tickets: "tickets",
});

const WORKFLOW_DIRECTORY_PATTERN = /^(WF-(?:\d{4}|[1-9]\d{4,}))-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_SLUG_LENGTH = 80;

function gitContext(options = {}) {
	return {
		...(options.runGitCommand === undefined ? {} : { runGitCommand: options.runGitCommand }),
		...(options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary }),
		...(options.env === undefined ? {} : { env: options.env }),
	};
}

async function git(cwd, args, options = {}) {
	const runGitCommand = options.runGitCommand ?? runGit;
	if (typeof runGitCommand !== "function") throw new ValidationError("runGitCommand must be a function.");
	return runGitCommand(args, {
		cwd,
		...(options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary }),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.allowNonZero === undefined ? {} : { allowNonZero: options.allowNonZero }),
	});
}

function normalizedTimestamp(clock) {
	if (typeof clock !== "function") throw new ValidationError("clock must be a function.");
	const value = clock();
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError("clock must return a valid timestamp.");
	return date.toISOString();
}

function normalizeTitle(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Workflow title must be a non-empty single-line string without NUL bytes.");
	}
	return value.trim();
}

function normalizeInitialIdea(value) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new ValidationError("initialIdea must be non-empty text without NUL bytes.");
	}
	return value.trim();
}

function normalizeRationale(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Cancellation rationale must be a non-empty single-line string.");
	}
	return value.trim();
}

function identityDescriptor(identity) {
	return {
		project_root: identity.projectRoot,
		project_key: identity.projectKey,
		object_format: identity.objectFormat,
		root_commit: identity.rootCommit,
	};
}

function storageDescriptor(storage) {
	return {
		mode: storage.mode,
		path: storage.path,
		effective_path: storage.effectivePath,
	};
}

function identityDescriptorsMatch(left, right) {
	return (
		left?.project_root === right?.project_root &&
		left?.project_key === right?.project_key &&
		left?.object_format === right?.object_format &&
		left?.root_commit === right?.root_commit
	);
}

function assertIdentityMatches(expected, actual) {
	const normalizedExpected = validateStorageIdentity(expected);
	const expectedDescriptor = identityDescriptor(normalizedExpected);
	const actualDescriptor = identityDescriptor(actual);
	if (!identityDescriptorsMatch(expectedDescriptor, actualDescriptor)) {
		throw new PlanMismatchError("The workflow operation does not match the current Git project identity.", {
			details: { expected: expectedDescriptor, actual: actualDescriptor },
		});
	}
	return normalizedExpected;
}

function assertStorageMatches(expected, actual) {
	const descriptor = storageDescriptor(actual);
	if (
		expected?.mode !== descriptor.mode ||
		expected?.path !== descriptor.path ||
		expected?.effective_path !== descriptor.effective_path
	) {
		throw new PlanMismatchError("Active workflow storage changed after the operation was reviewed.", {
			details: { expected, actual: descriptor },
		});
	}
	return actual;
}

function workflowNumber(workflowId) {
	validateWorkflowId(workflowId);
	return Number(workflowId.slice(3));
}

export function formatWorkflowId(number) {
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new ValidationError("Workflow number must be a positive safe integer.");
	}
	return `WF-${String(number).padStart(4, "0")}`;
}

export function generateImmutableSlug(title, { maxLength = DEFAULT_MAX_SLUG_LENGTH } = {}) {
	const normalizedTitle = normalizeTitle(title);
	if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
		throw new ValidationError("maxLength must be a positive safe integer.");
	}
	let slug = normalizedTitle
		.normalize("NFKD")
		.replace(/\p{Mark}+/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.replace(/-+/gu, "-");
	if (slug.length === 0) slug = "workflow";
	if (slug.length > maxLength) {
		slug = slug.slice(0, maxLength).replace(/-+$/gu, "");
		if (slug.length === 0) slug = "workflow".slice(0, maxLength);
	}
	validateImmutableSlug(slug);
	return slug;
}

export function workflowDirectoryName(workflowId, slug) {
	validateWorkflowId(workflowId);
	validateImmutableSlug(slug);
	return `${workflowId}-${slug}`;
}

function workflowPaths(storageRoot, workflowId, slug) {
	const directory = resolveWithinRoot(storageRoot, workflowDirectoryName(workflowId, slug));
	return {
		directory,
		manifest: resolveWithinRoot(directory, "workflow.md"),
		spec: resolveWithinRoot(directory, "spec.md"),
		baselines: resolveWithinRoot(directory, WORKFLOW_DIRECTORY_NAMES.baselines),
		decisions: resolveWithinRoot(directory, WORKFLOW_DIRECTORY_NAMES.decisions),
		tickets: resolveWithinRoot(directory, WORKFLOW_DIRECTORY_NAMES.tickets),
	};
}

async function rootManifestSnapshot(storage, identity) {
	const path = resolveWithinRoot(storage.effectivePath, ROOT_MANIFEST_NAME);
	const snapshot = await readFileWithDigest(path, { encoding: "utf8" });
	const parsed = parseRootManifest(snapshot.data, { path, expectedIdentity: identity });
	return { ...snapshot, path, metadata: parsed.metadata, body: parsed.body };
}

async function currentContext(identity, homeDirectory, options = {}) {
	const context = gitContext(options);
	const actualIdentity = await inspectGitProject(identity.projectRoot, context);
	assertIdentityMatches(identity, actualIdentity);
	const storage = await resolveActiveStorage(actualIdentity, { homeDirectory });
	return { context, identity: actualIdentity, storage };
}

async function assertTrackedProjectManifest(identity, manifestPath, options) {
	const relativePath = relative(identity.projectRoot, manifestPath);
	if (relativePath.startsWith("..")) {
		throw new WorkflowError("Project-mode root manifest is outside the Git worktree.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
		});
	}
	const result = await git(
		identity.projectRoot,
		["ls-files", "--error-unmatch", "--", relativePath],
		{ ...options, allowNonZero: true },
	);
	if (result.exitCode !== 0) {
		throw new WorkflowError(
			"Project storage setup must be committed before reserving a workflow ID. Commit or otherwise resolve the setup change and try again.",
			{
				code: ERROR_CODES.WORKFLOW_CONFLICT,
				details: { manifest_path: relativePath },
			},
		);
	}
	return relativePath;
}

async function validateProjectReservationBase(identity, status, baseBranch, manifestPath, options) {
	if (identity.detached || status.headBranch === null) {
		throw new WorkflowError(
			"Project storage requires a writable named base branch for the workflow-ID reservation; detached HEAD is unsupported.",
			{ code: ERROR_CODES.INVALID_WORKFLOW_STATE },
		);
	}
	if (typeof baseBranch !== "string" || baseBranch.length === 0) {
		throw new ValidationError("baseBranch is required for project storage mode.");
	}
	await assertValidLocalBranchName(identity.projectRoot, baseBranch, options);
	if (status.headBranch !== baseBranch) {
		throw new WorkflowError(`Project-mode reservation must run on selected base branch '${baseBranch}'.`, {
			code: ERROR_CODES.INVALID_WORKFLOW_STATE,
			details: { selected_base_branch: baseBranch, current_branch: status.headBranch },
		});
	}
	const branchCommit = await resolveLocalBranchCommit(identity.projectRoot, baseBranch, options);
	if (branchCommit !== status.headCommit) {
		throw new WorkflowError("The selected base branch tip does not match the checked-out commit.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { base_branch: baseBranch, branch_commit: branchCommit, head_commit: status.headCommit },
		});
	}
	return assertTrackedProjectManifest(identity, manifestPath, options);
}

export async function createWorkflowReservationPlan(
	identity,
	{
		title,
		baseBranch,
		homeDirectory = homedir(),
		clock = () => new Date(),
		...options
	} = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const normalizedTitle = normalizeTitle(title);
	const slug = generateImmutableSlug(normalizedTitle);
	const timestamp = normalizedTimestamp(clock);
	const current = await currentContext(normalizedIdentity, normalizedHome, options);
	const status = await assertCleanWorktree(current.identity.projectRoot, current.context);
	const root = await rootManifestSnapshot(current.storage, current.identity);
	const number = root.metadata.next_workflow_number;
	if (number >= Number.MAX_SAFE_INTEGER) {
		throw new WorkflowError("Workflow ID counter is exhausted and cannot be incremented safely.");
	}
	const id = formatWorkflowId(number);
	let selectedBaseBranch = status.headBranch;
	let manifestGitPath = null;
	if (current.storage.mode === "project") {
		selectedBaseBranch = baseBranch;
		manifestGitPath = await validateProjectReservationBase(
			current.identity,
			status,
			baseBranch,
			root.path,
			current.context,
		);
	} else if (baseBranch !== undefined && baseBranch !== status.headBranch) {
		throw new ValidationError("baseBranch, when provided for external storage, must match the current branch.");
	}
	const commitMessage = current.storage.mode === "project"
		? `chore(dbz-workflows): reserve ${id}`
		: null;
	return finalizePlan({
		operation: WORKFLOW_PLAN_OPERATIONS.RESERVATION,
		plan_version: 1,
		created_at: timestamp,
		identity: identityDescriptor(current.identity),
		home_directory: normalizedHome,
		storage: storageDescriptor(current.storage),
		workflow: { id, number, title: normalizedTitle, slug },
		counter: { before: number, after: number + 1 },
		root_manifest: { path: root.path, digest: root.digest },
		source: {
			worktree_path: current.identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
			base_branch: selectedBaseBranch,
		},
		reservation_commit: current.storage.mode === "project"
			? { message: commitMessage, path: manifestGitPath }
			: null,
		changes: [
			{
				action: "reserve_workflow_id",
				path: root.path,
				workflow_id: id,
				counter_before: number,
				counter_after: number + 1,
			},
			...(commitMessage === null
				? []
				: [{ action: "commit_project_reservation", branch: selectedBaseBranch, message: commitMessage }]),
		],
	});
}

async function assertReservationPlanState(plan, identity, homeDirectory, options) {
	const current = await currentContext(identity, homeDirectory, options);
	assertStorageMatches(plan.storage, current.storage);
	const status = await assertCleanWorktree(current.identity.projectRoot, current.context);
	if (status.headCommit !== plan.source.head_commit || status.headBranch !== plan.source.head_branch) {
		throw new PlanMismatchError("Git HEAD changed after the workflow reservation was reviewed.", {
			details: {
				expected_commit: plan.source.head_commit,
				actual_commit: status.headCommit,
				expected_branch: plan.source.head_branch,
				actual_branch: status.headBranch,
			},
		});
	}
	const root = await rootManifestSnapshot(current.storage, current.identity);
	if (root.path !== plan.root_manifest.path || root.digest !== plan.root_manifest.digest) {
		throw new PlanMismatchError("The root manifest changed after the workflow reservation was reviewed.", {
			details: {
				expected_digest: plan.root_manifest.digest,
				actual_digest: root.digest,
			},
		});
	}
	if (
		root.metadata.next_workflow_number !== plan.counter.before ||
		formatWorkflowId(root.metadata.next_workflow_number) !== plan.workflow.id
	) {
		throw new PlanMismatchError("The next workflow ID changed after the reservation was reviewed.");
	}
	if (current.storage.mode === "project") {
		await validateProjectReservationBase(
			current.identity,
			status,
			plan.source.base_branch,
			root.path,
			current.context,
		);
	}
	return { ...current, status, root };
}

async function restoreUncommittedReservation(root, previousSource, replacementDigest) {
	let current;
	try {
		current = await readFileWithDigest(root.path);
	} catch {
		return false;
	}
	if (current.digest !== replacementDigest) return false;
	await atomicWriteFile(root.path, previousSource, {
		expectedDigest: replacementDigest,
		root: resolve(root.path, ".."),
	});
	return true;
}

async function commitProjectReservation(plan, state, replacementDigest) {
	const commit = plan.reservation_commit;
	let failure;
	try {
		await git(
			state.identity.projectRoot,
			["commit", "--only", "--message", commit.message, "--", commit.path],
			state.context,
		);
	} catch (error) {
		failure = error;
	}
	const after = await inspectGitProject(state.identity.projectRoot, state.context);
	if (failure !== undefined) {
		if (after.headCommit === plan.source.head_commit) {
			const restored = await restoreUncommittedReservation(state.root, state.root.data, replacementDigest);
			throw new WorkflowError(
				restored
					? "Git could not create the confirmed workflow-ID reservation commit; the uncommitted counter change was restored."
					: "Git could not create the confirmed workflow-ID reservation commit, and the counter file changed before it could be restored safely.",
				{
					code: ERROR_CODES.WORKFLOW_CONFLICT,
					details: { restored, base_branch: plan.source.base_branch },
					cause: failure,
				},
			);
		}
		throw new WorkflowError(
			"Git reported a reservation-commit failure after HEAD changed. The commit was not rewritten or removed; inspect the repository before continuing.",
			{
				code: ERROR_CODES.WORKFLOW_CONFLICT,
				details: { committed: true, previous_commit: plan.source.head_commit, actual_commit: after.headCommit },
				cause: failure,
			},
		);
	}
	if (after.headRef !== plan.source.base_branch || after.headCommit === plan.source.head_commit) {
		throw new WorkflowError("Workflow-ID reservation commit did not produce the expected named-base state.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { base_branch: after.headRef, commit: after.headCommit },
		});
	}
	const parentResult = await git(state.identity.projectRoot, ["rev-parse", `${after.headCommit}^`], state.context);
	if (parentResult.stdout.trim() !== plan.source.head_commit) {
		throw new WorkflowError("Workflow-ID reservation commit does not directly follow the reviewed base commit.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { commit: after.headCommit, expected_parent: plan.source.head_commit },
		});
	}
	const changedResult = await git(
		state.identity.projectRoot,
		["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", after.headCommit],
		state.context,
	);
	const changed = changedResult.stdout.split("\0").filter(Boolean);
	if (changed.length !== 1 || changed[0] !== commit.path) {
		throw new WorkflowError("Reservation commit contains changes beyond the root workflow counter.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { committed: true, commit: after.headCommit, changed_paths: changed },
		});
	}
	const committedRoot = await readFileWithDigest(state.root.path);
	if (committedRoot.digest !== replacementDigest) {
		throw new WorkflowError("The project root manifest changed after its reservation commit.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { committed: true, commit: after.headCommit },
		});
	}
	try {
		await assertCleanWorktree(state.identity.projectRoot, state.context);
	} catch (error) {
		throw new WorkflowError("The reservation commit completed, but a Git hook left the worktree dirty.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { committed: true, commit: after.headCommit },
			cause: error,
		});
	}
	return after.headCommit;
}

export async function applyWorkflowReservationPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		lockOptions,
		...options
	} = {},
) {
	validateReviewedPlan(plan, WORKFLOW_PLAN_OPERATIONS.RESERVATION);
	requirePlanAuthorization(plan, authorization);
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	if (!identityDescriptorsMatch(plan.identity, identityDescriptor(normalizedIdentity))) {
		throw new PlanMismatchError("The reservation plan belongs to a different Git project identity.");
	}
	if (plan.home_directory !== normalizedHome) {
		throw new PlanMismatchError("The reservation plan was created for a different home directory.");
	}
	let state = await assertReservationPlanState(plan, normalizedIdentity, normalizedHome, options);
	const lockPath = operationLockPath(normalizedIdentity.projectKey, state.storage.effectivePath, {
		homeDirectory: normalizedHome,
	});
	await prepareOperationLock(lockPath);
	return withLocalMutationLock(lockPath, async () => {
		state = await assertReservationPlanState(plan, normalizedIdentity, normalizedHome, options);
		const replacement = patchFrontmatter(
			state.root.data,
			[
				{ path: ["next_workflow_number"], value: plan.counter.after },
				{ path: ["updated_at"], value: plan.created_at },
			],
			{ path: state.root.path },
		);
		parseRootManifest(replacement, { path: state.root.path, expectedIdentity: state.identity });
		const written = await atomicWriteFile(state.root.path, replacement, {
			expectedDigest: state.root.digest,
			root: state.storage.effectivePath,
		});
		let reservationCommit = null;
		if (state.storage.mode === "project") {
			reservationCommit = await commitProjectReservation(plan, state, written.digest);
		}
		const baseCommit = reservationCommit ?? plan.source.head_commit;
		return {
			operation: WORKFLOW_PLAN_OPERATIONS.RESERVATION,
			changed: true,
			workflow_id: plan.workflow.id,
			reservation: {
				workflow: { ...plan.workflow },
				storage: { ...plan.storage },
				base_branch: plan.source.base_branch,
				base_commit: baseCommit,
				root_manifest_digest: written.digest,
				reserved_at: plan.created_at,
				reservation_commit: reservationCommit,
			},
		};
	}, lockOptions);
}

function validateReservationRecord(reservation, identity) {
	if (reservation === null || typeof reservation !== "object" || Array.isArray(reservation)) {
		throw new ValidationError("reservation must be the result of an applied workflow-ID reservation.");
	}
	const workflow = reservation.workflow;
	validateWorkflowId(workflow?.id);
	if (workflowNumber(workflow.id) !== workflow.number) {
		throw new ValidationError("Reservation workflow ID and number are inconsistent.");
	}
	normalizeTitle(workflow.title);
	validateImmutableSlug(workflow.slug);
	if (generateImmutableSlug(workflow.title) !== workflow.slug) {
		throw new ValidationError("Reservation slug is not derived from its original workflow title.");
	}
	validateObjectId(identity.objectFormat, reservation.base_commit, { name: "Reservation base commit" });
	if (reservation.base_branch !== null && typeof reservation.base_branch !== "string") {
		throw new ValidationError("Reservation base_branch must be null or a branch name.");
	}
	if (!SHA256_PATTERN.test(reservation.root_manifest_digest)) {
		throw new ValidationError("Reservation root_manifest_digest must be a SHA-256 digest.");
	}
	return reservation;
}

async function assertReservationConsumed(storage, identity, reservation) {
	const root = await rootManifestSnapshot(storage, identity);
	if (root.metadata.next_workflow_number <= reservation.workflow.number) {
		throw new WorkflowError("Workflow ID reservation is not durable in the active root manifest.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: {
				workflow_id: reservation.workflow.id,
				next_workflow_number: root.metadata.next_workflow_number,
			},
		});
	}
	return root;
}

async function entryState(path) {
	try {
		const entry = await lstat(path);
		return {
			exists: true,
			kind: entry.isSymbolicLink()
				? "symlink"
				: entry.isDirectory()
					? "directory"
					: entry.isFile()
						? "file"
						: "other",
		};
	} catch (error) {
		if (error?.code === "ENOENT") return { exists: false, kind: "missing" };
		throw error;
	}
}

async function assertWorkflowDestinationAbsent(paths) {
	const state = await entryState(paths.directory);
	if (state.exists) {
		throw new WorkflowError("Canonical workflow destination already exists and will not be overwritten.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { path: paths.directory, kind: state.kind },
		});
	}
}

async function inspectAdoptableWorkflow(paths, identity, reservation) {
	const directoryState = await entryState(paths.directory);
	if (!directoryState.exists || directoryState.kind !== "directory") {
		throw new WorkflowError("Workflow-branch adoption requires an existing real canonical workflow directory.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { path: paths.directory, kind: directoryState.kind },
		});
	}
	const [workflowSnapshot, specSnapshot] = await Promise.all([
		readFileWithDigest(paths.manifest, { encoding: "utf8" }),
		readFileWithDigest(paths.spec, { encoding: "utf8" }),
	]);
	const parsed = parseWorkflowArtifact(workflowSnapshot.data, {
		path: paths.manifest,
		expectedId: reservation.workflow.id,
		expectedSlug: reservation.workflow.slug,
		objectFormat: identity.objectFormat,
	});
	const expectedBranch = workflowBranchName(reservation.workflow.id, reservation.workflow.slug);
	if (
		parsed.data.git.base_branch !== reservation.base_branch ||
		parsed.data.git.base_commit !== reservation.base_commit ||
		parsed.data.git.workflow_branch !== expectedBranch
	) {
		throw new WorkflowError("Existing canonical workflow metadata does not match the reserved workflow base and branch.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { workflow_id: reservation.workflow.id, expected_branch: expectedBranch },
		});
	}
	const spec = parseFrontmatter(specSnapshot.data, { path: paths.spec });
	if (spec.data.artifact !== "spec" || spec.data.workflow_id !== reservation.workflow.id) {
		throw new WorkflowError("Existing spec.md does not belong to the reserved workflow.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { workflow_id: reservation.workflow.id, path: paths.spec },
		});
	}
	indexLevelTwoSections(specSnapshot.data, { path: paths.spec });
	for (const directory of [paths.baselines, paths.decisions, paths.tickets]) {
		const state = await entryState(directory);
		if (!state.exists || state.kind !== "directory") {
			throw new WorkflowError("Existing workflow adoption requires the complete canonical directory scaffold.", {
				code: ERROR_CODES.WORKFLOW_CONFLICT,
				details: { path: directory, kind: state.kind },
			});
		}
	}
	return {
		metadata: parsed.data,
		workflowDigest: workflowSnapshot.digest,
		specDigest: specSnapshot.digest,
	};
}

function workflowMetadataFromPlan(plan) {
	if (plan.action === "adopt_existing") return plan.artifacts.workflow.metadata;
	return parseFrontmatter(plan.artifacts.workflow.source, { path: plan.artifacts.workflow.path }).data;
}

export async function createWorkflowStartPlan(
	identity,
	{
		reservation,
		initialIdea,
		homeDirectory = homedir(),
		clock = () => new Date(),
		adoptExistingCommit,
		...options
	} = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const normalizedIdea = normalizeInitialIdea(initialIdea);
	const timestamp = normalizedTimestamp(clock);
	const current = await currentContext(normalizedIdentity, normalizedHome, options);
	const record = validateReservationRecord(reservation, current.identity);
	assertStorageMatches(record.storage, current.storage);
	await assertReservationConsumed(current.storage, current.identity, record);
	const status = await assertCleanWorktree(current.identity.projectRoot, current.context);
	if (status.headCommit !== record.base_commit || status.headBranch !== record.base_branch) {
		throw new WorkflowError("Workflow branch creation must begin from the exact reserved base ref and commit.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: {
				expected_commit: record.base_commit,
				actual_commit: status.headCommit,
				expected_branch: record.base_branch,
				actual_branch: status.headBranch,
			},
		});
	}
	if (current.storage.mode === "project" && record.base_branch === null) {
		throw new WorkflowError("Project-mode workflow creation cannot use a detached reservation base.");
	}
	const paths = workflowPaths(current.storage.effectivePath, record.workflow.id, record.workflow.slug);
	const destination = await entryState(paths.directory);
	let adoption = null;
	if (adoptExistingCommit === undefined) {
		await assertWorkflowDestinationAbsent(paths);
	} else {
		if (!destination.exists) {
			throw new WorkflowError(
				"Existing workflow branch adoption requires matching canonical workflow metadata; the canonical directory is absent.",
				{ code: ERROR_CODES.WORKFLOW_CONFLICT, details: { path: paths.directory } },
			);
		}
		adoption = await inspectAdoptableWorkflow(paths, current.identity, record);
	}
	const branchPlan = await createWorkflowBranchPlan({
		cwd: current.identity.projectRoot,
		workflowId: record.workflow.id,
		workflowSlug: record.workflow.slug,
		baseRef: record.base_branch ?? "HEAD",
		expectedBaseCommit: record.base_commit,
		...(adoptExistingCommit === undefined ? {} : { adoptExistingCommit }),
		...current.context,
	});
	const action = adoption === null ? "create" : "adopt_existing";
	const metadata = adoption?.metadata ?? {
		artifact: "workflow",
		schema_version: 1,
		id: record.workflow.id,
		title: record.workflow.title,
		slug: record.workflow.slug,
		phase: "discovery",
		conditions: [],
		current_baseline: null,
		next_baseline_number: 1,
		next_ticket_number: 1,
		next_decision_number: 1,
		issues: [],
		git: {
			base_branch: record.base_branch,
			base_commit: record.base_commit,
			workflow_branch: branchPlan.branch,
			integrated_commit: null,
		},
		created_at: timestamp,
		updated_at: timestamp,
	};
	const workflowSource = action === "create"
		? createWorkflowArtifactSource(metadata, { objectFormat: current.identity.objectFormat })
		: null;
	const specSource = action === "create"
		? createInitialSpecArtifactSource({
			workflowId: record.workflow.id,
			title: record.workflow.title,
			initialIdea: normalizedIdea,
			timestamp,
		})
		: null;
	return finalizePlan({
		operation: WORKFLOW_PLAN_OPERATIONS.START,
		plan_version: 1,
		action,
		created_at: timestamp,
		identity: identityDescriptor(current.identity),
		home_directory: normalizedHome,
		storage: storageDescriptor(current.storage),
		reservation: {
			workflow: { ...record.workflow },
			base_branch: record.base_branch,
			base_commit: record.base_commit,
			root_manifest_digest: record.root_manifest_digest,
			reserved_at: record.reserved_at,
			reservation_commit: record.reservation_commit,
		},
		source: {
			worktree_path: current.identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
		},
		branch_plan: branchPlan,
		artifacts: {
			directory: paths.directory,
			workflow: action === "create"
				? { path: paths.manifest, source: workflowSource }
				: { path: paths.manifest, digest: adoption.workflowDigest, metadata },
			spec: action === "create"
				? { path: paths.spec, source: specSource }
				: { path: paths.spec, digest: adoption.specDigest },
			directories: [paths.baselines, paths.decisions, paths.tickets],
		},
		changes: [
			...branchPlan.changes,
			...(action === "create"
				? [
					{ action: "create_workflow_artifact", path: paths.manifest },
					{ action: "create_spec_draft", path: paths.spec },
				]
				: []),
		],
	});
}

async function assertStartPlanState(plan, identity, homeDirectory, options) {
	const current = await currentContext(identity, homeDirectory, options);
	assertStorageMatches(plan.storage, current.storage);
	const status = await assertCleanWorktree(current.identity.projectRoot, current.context);
	if (status.headCommit !== plan.source.head_commit || status.headBranch !== plan.source.head_branch) {
		throw new PlanMismatchError("Git HEAD changed after workflow start was reviewed.");
	}
	const reservation = validateReservationRecord(
		{
			...plan.reservation,
			storage: plan.storage,
		},
		current.identity,
	);
	await assertReservationConsumed(current.storage, current.identity, reservation);
	const expectedPaths = workflowPaths(
		current.storage.effectivePath,
		reservation.workflow.id,
		reservation.workflow.slug,
	);
	if (
		plan.artifacts.directory !== expectedPaths.directory ||
		plan.artifacts.workflow.path !== expectedPaths.manifest ||
		plan.artifacts.spec.path !== expectedPaths.spec ||
		JSON.stringify(plan.artifacts.directories) !==
			JSON.stringify([expectedPaths.baselines, expectedPaths.decisions, expectedPaths.tickets])
	) {
		throw new PlanMismatchError("Workflow start plan contains inconsistent canonical artifact paths.");
	}
	if (plan.action === "create") {
		await assertWorkflowDestinationAbsent(expectedPaths);
	} else if (plan.action === "adopt_existing") {
		const adoption = await inspectAdoptableWorkflow(expectedPaths, current.identity, reservation);
		if (
			adoption.workflowDigest !== plan.artifacts.workflow.digest ||
			adoption.specDigest !== plan.artifacts.spec.digest
		) {
			throw new PlanMismatchError("Existing canonical workflow metadata changed after adoption was reviewed.");
		}
	} else {
		throw new PlanMismatchError(`Unsupported workflow start action '${String(plan.action)}'.`);
	}
	const metadata = workflowMetadataFromPlan(plan);
	validateWorkflowMetadata(metadata, {
		expectedId: reservation.workflow.id,
		expectedSlug: reservation.workflow.slug,
		objectFormat: current.identity.objectFormat,
		path: expectedPaths.manifest,
	});
	if (plan.action === "create") {
		indexLevelTwoSections(plan.artifacts.workflow.source, { path: expectedPaths.manifest });
		indexLevelTwoSections(plan.artifacts.spec.source, { path: expectedPaths.spec });
	}
	return { ...current, status, reservation, paths: expectedPaths, metadata };
}

async function removeOwnedFile(path, digest) {
	try {
		const snapshot = await readFileWithDigest(path);
		if (snapshot.digest !== digest) return false;
		await unlink(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		return false;
	}
}

async function createWorkflowArtifacts(state, plan) {
	const mode = state.storage.mode === "project" ? 0o755 : 0o700;
	const fileMode = state.storage.mode === "project" ? 0o644 : 0o600;
	const createdDirectories = [];
	const createdFiles = [];
	try {
		await mkdir(state.paths.directory, { mode });
		createdDirectories.push(state.paths.directory);
		for (const directory of plan.artifacts.directories) {
			await mkdir(directory, { mode });
			createdDirectories.push(directory);
		}
		for (const artifact of [plan.artifacts.workflow, plan.artifacts.spec]) {
			try {
				const written = await atomicWriteFile(artifact.path, artifact.source, {
					expectedDigest: null,
				mode: fileMode,
				root: state.storage.effectivePath,
				});
				createdFiles.push({ path: artifact.path, digest: written.digest });
			} catch (error) {
				if (error?.details?.committed === true) {
					createdFiles.push({ path: artifact.path, digest: sha256Hex(artifact.source) });
				}
				throw error;
			}
		}
	} catch (error) {
		for (const file of createdFiles.reverse()) await removeOwnedFile(file.path, file.digest);
		for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => {});
		throw error;
	}
	return createdFiles;
}

export async function applyWorkflowStartPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		lockOptions,
		...options
	} = {},
) {
	validateReviewedPlan(plan, WORKFLOW_PLAN_OPERATIONS.START);
	requirePlanAuthorization(plan, authorization);
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	if (!identityDescriptorsMatch(plan.identity, identityDescriptor(normalizedIdentity))) {
		throw new PlanMismatchError("The workflow start plan belongs to a different Git project identity.");
	}
	if (plan.home_directory !== normalizedHome) {
		throw new PlanMismatchError("The workflow start plan was created for a different home directory.");
	}
	let state = await assertStartPlanState(plan, normalizedIdentity, normalizedHome, options);
	const lockPath = operationLockPath(normalizedIdentity.projectKey, state.storage.effectivePath, {
		homeDirectory: normalizedHome,
	});
	await prepareOperationLock(lockPath);
	return withLocalMutationLock(lockPath, async () => {
		state = await assertStartPlanState(plan, normalizedIdentity, normalizedHome, options);
		const branchResult = await applyWorkflowBranchPlan(plan.branch_plan, {
			authorization: { confirmed: true, planDigest: plan.branch_plan.plan_digest },
			...state.context,
		});
		const expectedBranchCommit = plan.action === "create"
			? state.metadata.git.base_commit
			: plan.branch_plan.existing_commit;
		if (
			branchResult.branch !== state.metadata.git.workflow_branch ||
			branchResult.commit !== expectedBranchCommit
		) {
			throw new WorkflowError("Workflow branch operation did not produce the commit recorded by the reviewed start action.", {
				code: ERROR_CODES.WORKFLOW_CONFLICT,
			});
		}
		const files = plan.action === "create" ? await createWorkflowArtifacts(state, plan) : [];
		const inspected = await inspectWorkflow(normalizedIdentity, state.metadata.id, {
			homeDirectory: normalizedHome,
		});
		return {
			operation: WORKFLOW_PLAN_OPERATIONS.START,
			changed: plan.action === "create" || branchResult.changed,
			action: plan.action,
			workflow: inspected,
			branch: branchResult,
			created_files: files.map(({ path, digest }) => ({ path, digest })),
			git_changes: state.storage.mode === "project"
				? files.map(({ path }) => ({ change: "created", path: relative(normalizedIdentity.projectRoot, path) }))
				: [],
		};
	}, lockOptions);
}

function parseWorkflowDirectoryName(name) {
	const match = WORKFLOW_DIRECTORY_PATTERN.exec(name);
	if (!match) return null;
	return { id: match[1], slug: match[2] };
}

function parseWorkflowArtifact(source, { path, expectedId, expectedSlug, objectFormat }) {
	const parsed = parseFrontmatter(source, { path });
	validateWorkflowMetadata(parsed.data, { path, expectedId, expectedSlug, objectFormat });
	indexLevelTwoSections(source, { path });
	return parsed;
}

async function listWorkflowsInStorage(storage, identity) {
	let entries;
	try {
		entries = await readdir(storage.effectivePath, { withFileTypes: true });
	} catch (error) {
		throw new WorkflowError("Canonical workflow storage cannot be listed safely.", { cause: error });
	}
	const workflows = [];
	const ids = new Set();
	for (const entry of entries) {
		const directoryIdentity = parseWorkflowDirectoryName(entry.name);
		if (directoryIdentity === null) continue;
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			throw new WorkflowError("Canonical workflow path must be a real directory, not a file or symbolic link.", {
				code: ERROR_CODES.WORKFLOW_CONFLICT,
				details: { path: resolve(storage.effectivePath, entry.name) },
			});
		}
		if (ids.has(directoryIdentity.id)) {
			throw new WorkflowError(`Workflow ID '${directoryIdentity.id}' appears in more than one canonical directory.`, {
				code: ERROR_CODES.WORKFLOW_CONFLICT,
			});
		}
		ids.add(directoryIdentity.id);
		const paths = workflowPaths(storage.effectivePath, directoryIdentity.id, directoryIdentity.slug);
		let snapshot;
		try {
			snapshot = await readFileWithDigest(paths.manifest, { encoding: "utf8" });
		} catch (error) {
			throw new WorkflowError("Canonical workflow directory is missing a safe workflow.md artifact.", {
				code: ERROR_CODES.WORKFLOW_CONFLICT,
				details: { workflow_id: directoryIdentity.id, path: paths.manifest },
				cause: error,
			});
		}
		const parsed = parseWorkflowArtifact(snapshot.data, {
			path: paths.manifest,
			expectedId: directoryIdentity.id,
			expectedSlug: directoryIdentity.slug,
			objectFormat: identity.objectFormat,
		});
		workflows.push({
			id: parsed.data.id,
			title: parsed.data.title,
			slug: parsed.data.slug,
			phase: parsed.data.phase,
			conditions: [...parsed.data.conditions],
			current_baseline: parsed.data.current_baseline,
			issues: parsed.data.issues.map((issue) => ({ ...issue })),
			updated_at: parsed.data.updated_at,
			path: paths.manifest,
			directory: paths.directory,
			digest: snapshot.digest,
			metadata: parsed.data,
		});
	}
	workflows.sort((left, right) => workflowNumber(left.id) - workflowNumber(right.id));
	return workflows;
}

export async function listWorkflows(identity, { homeDirectory = homedir() } = {}) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const current = await currentContext(normalizedIdentity, normalizedHome);
	return listWorkflowsInStorage(current.storage, current.identity);
}

async function inspectWorkflowInStorage(storage, identity, workflowId) {
	validateWorkflowId(workflowId);
	const workflows = await listWorkflowsInStorage(storage, identity);
	const workflow = workflows.find(({ id }) => id === workflowId);
	if (!workflow) {
		throw new WorkflowError(`Workflow '${workflowId}' was not found in active storage.`, {
			code: ERROR_CODES.WORKFLOW_NOT_FOUND,
			details: { workflow_id: workflowId, storage_path: storage.path },
		});
	}
	return workflow;
}

export async function inspectWorkflow(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const current = await currentContext(normalizedIdentity, normalizedHome);
	return inspectWorkflowInStorage(current.storage, current.identity, workflowId);
}

function requireExpectedDigest(expectedDigest) {
	if (typeof expectedDigest !== "string" || !SHA256_PATTERN.test(expectedDigest)) {
		throw new ValidationError("expectedDigest must be the lowercase SHA-256 digest returned by workflow inspection.");
	}
	return expectedDigest;
}

async function mutateWorkflow(
	identity,
	workflowId,
	{
		expectedDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	},
	mutator,
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const digest = requireExpectedDigest(expectedDigest);
	const timestamp = normalizedTimestamp(clock);
	let current = await currentContext(normalizedIdentity, normalizedHome);
	const expectedStorage = storageDescriptor(current.storage);
	let workflow = await inspectWorkflowInStorage(current.storage, current.identity, workflowId);
	const lockPath = operationLockPath(normalizedIdentity.projectKey, current.storage.effectivePath, {
		homeDirectory: normalizedHome,
	});
	await prepareOperationLock(lockPath);
	return withLocalMutationLock(lockPath, async () => {
		current = await currentContext(normalizedIdentity, normalizedHome);
		assertStorageMatches(expectedStorage, current.storage);
		workflow = await inspectWorkflowInStorage(current.storage, current.identity, workflowId);
		if (workflow.digest !== digest) {
			throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`, {
				details: { expected_digest: digest, actual_digest: workflow.digest },
			});
		}
		const patches = await mutator(workflow.metadata, timestamp);
		if (!Array.isArray(patches)) throw new ValidationError("Workflow mutator must return metadata patches.");
		if (patches.length === 0) return { changed: false, workflow };
		const source = (await readFileWithDigest(workflow.path, { encoding: "utf8" })).data;
		const replacement = patchFrontmatter(source, patches, { path: workflow.path });
		parseWorkflowArtifact(replacement, {
			path: workflow.path,
			expectedId: workflow.id,
			expectedSlug: workflow.slug,
			objectFormat: current.identity.objectFormat,
		});
		await atomicWriteFile(workflow.path, replacement, {
			expectedDigest: workflow.digest,
			root: current.storage.effectivePath,
		});
		return {
			changed: true,
			workflow: await inspectWorkflowInStorage(current.storage, current.identity, workflowId),
		};
	}, lockOptions);
}

export async function updateWorkflowTitle(identity, workflowId, title, options = {}) {
	const normalizedTitle = normalizeTitle(title);
	return mutateWorkflow(identity, workflowId, options, (metadata, timestamp) => {
		if (metadata.title === normalizedTitle) return [];
		return [
			{ path: ["title"], value: normalizedTitle },
			{ path: ["updated_at"], value: timestamp },
		];
	});
}

export async function transitionWorkflowPhase(identity, workflowId, toPhase, options = {}) {
	if (!WORKFLOW_PHASES.includes(toPhase)) throw new ValidationError(`Unsupported workflow phase '${String(toPhase)}'.`);
	if (toPhase === "cancelled") {
		throw new WorkflowError("Use cancelWorkflow() so cancellation records its required rationale.", {
			code: ERROR_CODES.INVALID_WORKFLOW_TRANSITION,
		});
	}
	if (toPhase === "completed") {
		throw new WorkflowError("Workflow completion requires the guarded verification and final-integration operation.", {
			code: ERROR_CODES.INVALID_WORKFLOW_TRANSITION,
		});
	}
	return mutateWorkflow(identity, workflowId, options, (metadata, timestamp) => {
		let transition;
		try {
			transition = assertWorkflowPhaseTransition(metadata.phase, toPhase);
		} catch (error) {
			throw new WorkflowError(error.message, {
				code: ERROR_CODES.INVALID_WORKFLOW_TRANSITION,
				details: error.details,
				cause: error,
			});
		}
		if (!transition.changed) return [];
		const phaseOrder = ["discovery", "planning", "ready", "execution", "verification"];
		if (
			metadata.conditions.includes("blocked") &&
			phaseOrder.indexOf(toPhase) > phaseOrder.indexOf(metadata.phase)
		) {
			throw new WorkflowError("A blocked workflow cannot advance until its blocked condition is cleared.", {
				code: ERROR_CODES.INVALID_WORKFLOW_TRANSITION,
				details: { from_phase: metadata.phase, to_phase: toPhase },
			});
		}
		const conditions = metadata.conditions.filter(
			(condition) => condition !== "awaiting-integration" || toPhase === "verification",
		);
		if (["completed", "cancelled"].includes(toPhase)) conditions.length = 0;
		assertWorkflowConditions(conditions, toPhase);
		return [
			{ path: ["phase"], value: toPhase },
			{ path: ["conditions"], value: conditions },
			{ path: ["updated_at"], value: timestamp },
		];
	});
}

export async function setWorkflowCondition(identity, workflowId, condition, enabled, options = {}) {
	if (!WORKFLOW_CONDITIONS.includes(condition)) {
		throw new ValidationError(`Workflow condition must be one of: ${WORKFLOW_CONDITIONS.join(", ")}.`);
	}
	if (typeof enabled !== "boolean") throw new ValidationError("enabled must be a boolean.");
	return mutateWorkflow(identity, workflowId, options, (metadata, timestamp) => {
		const present = metadata.conditions.includes(condition);
		if (present === enabled) return [];
		const conditions = enabled
			? [...metadata.conditions, condition]
			: metadata.conditions.filter((candidate) => candidate !== condition);
		assertWorkflowConditions(conditions, metadata.phase);
		return [
			{ path: ["conditions"], value: conditions },
			{ path: ["updated_at"], value: timestamp },
		];
	});
}

export async function setWorkflowIssueLinks(identity, workflowId, links, options = {}) {
	const normalized = normalizeIssueLinks(links);
	return mutateWorkflow(identity, workflowId, options, (metadata, timestamp) => {
		if (JSON.stringify(metadata.issues) === JSON.stringify(normalized)) return [];
		return [
			{ path: ["issues"], value: normalized },
			{ path: ["updated_at"], value: timestamp },
		];
	});
}

export async function cancelWorkflow(identity, workflowId, rationale, options = {}) {
	const normalizedRationale = normalizeRationale(rationale);
	return mutateWorkflow(identity, workflowId, options, (metadata, timestamp) => {
		if (metadata.phase === "completed" || metadata.phase === "cancelled") {
			throw new WorkflowError(`Workflow '${workflowId}' is terminal and cannot be cancelled.`, {
				code: ERROR_CODES.INVALID_WORKFLOW_TRANSITION,
				details: { phase: metadata.phase },
			});
		}
		assertWorkflowPhaseTransition(metadata.phase, "cancelled");
		return [
			{ path: ["phase"], value: "cancelled" },
			{ path: ["conditions"], value: [] },
			{
				path: ["cancellation"],
				value: { rationale: normalizedRationale, cancelled_at: timestamp },
			},
			{ path: ["updated_at"], value: timestamp },
		];
	});
}

export async function validateWorkflowContinuation(
	identity,
	workflowId,
	{ homeDirectory = homedir(), ...options } = {},
) {
	const normalizedIdentity = validateStorageIdentity(identity);
	const normalizedHome = resolve(homeDirectory);
	const current = await currentContext(normalizedIdentity, normalizedHome, options);
	const workflow = await inspectWorkflowInStorage(current.storage, current.identity, workflowId);
	if (["completed", "cancelled"].includes(workflow.phase)) {
		throw new WorkflowError(`Workflow '${workflowId}' is terminal and cannot be continued.`, {
			code: ERROR_CODES.INVALID_WORKFLOW_STATE,
			details: { workflow_id: workflowId, phase: workflow.phase },
		});
	}
	const branch = workflow.metadata.git.workflow_branch;
	const branchCommit = await resolveLocalBranchCommit(current.identity.projectRoot, branch, current.context);
	if (branchCommit === null) {
		throw new WorkflowError(`Workflow branch '${branch}' does not exist.`, {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: { workflow_id: workflowId, workflow_branch: branch },
		});
	}
	const baseContained = await isCommitAncestor(
		current.identity.projectRoot,
		workflow.metadata.git.base_commit,
		branchCommit,
		current.context,
	);
	if (!baseContained) {
		throw new WorkflowError("Workflow branch no longer descends from its recorded base commit.", {
			code: ERROR_CODES.WORKFLOW_CONFLICT,
			details: {
				workflow_id: workflowId,
				base_commit: workflow.metadata.git.base_commit,
				workflow_branch: branch,
				branch_commit: branchCommit,
			},
		});
	}
	return {
		workflow,
		storage: storageDescriptor(current.storage),
		workflow_branch: branch,
		branch_commit: branchCommit,
		current_branch: current.identity.headRef,
		requires_branch_switch: current.identity.headRef !== branch,
	};
}

export {
	ISSUE_RELATIONS,
	WORKFLOW_CONDITIONS,
	WORKFLOW_PHASES,
	GIT_PLAN_OPERATIONS,
};
