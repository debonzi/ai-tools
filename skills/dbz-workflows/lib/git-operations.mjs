import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	GitCommandError,
	GitStateError,
	ValidationError,
} from "./errors.mjs";
import {
	inspectGitProject,
	runGit,
	validateObjectId,
} from "./git-identity.mjs";

const WORKFLOW_ID_PATTERN = /^WF-(?:\d{4}|[1-9]\d{4,})$/u;
const TICKET_ID_PATTERN = /^T-(?:\d{4}|[1-9]\d{4,})$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TRAILER_KEYS = Object.freeze({
	workflow: "DBZ-Workflow",
	ticket: "DBZ-Ticket",
});

function assertSingleLineString(value, name) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError(`${name} must be a non-empty single-line string without NUL bytes.`);
	}
	return value;
}

function commandOptions(cwd, options = {}) {
	return {
		cwd,
		...(options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary }),
		...(options.env === undefined ? {} : { env: options.env }),
	};
}

async function git(cwd, args, options = {}) {
	const runGitCommand = options.runGitCommand ?? runGit;
	if (typeof runGitCommand !== "function") {
		throw new ValidationError("runGitCommand must be a function.");
	}
	return runGitCommand(args, {
		...commandOptions(cwd, options),
		...(options.allowNonZero === undefined ? {} : { allowNonZero: options.allowNonZero }),
	});
}

function validateNumberedId(value, pattern, prefix, name) {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new ValidationError(`${name} must use '${prefix}-' followed by a zero-padded number of at least four digits.`);
	}
	const number = value.slice(prefix.length + 1);
	if (/^0+$/u.test(number)) {
		throw new ValidationError(`${name} number must be greater than zero.`);
	}
	return value;
}

export function validateWorkflowId(workflowId) {
	return validateNumberedId(workflowId, WORKFLOW_ID_PATTERN, "WF", "workflowId");
}

export function validateTicketId(ticketId) {
	return validateNumberedId(ticketId, TICKET_ID_PATTERN, "T", "ticketId");
}

export function validateImmutableSlug(slug) {
	if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
		throw new ValidationError("slug must be a non-empty lowercase kebab-case identifier.");
	}
	return slug;
}

export function workflowBranchName(workflowId, workflowSlug) {
	validateWorkflowId(workflowId);
	validateImmutableSlug(workflowSlug);
	return `dbz-workflows/${workflowId}-${workflowSlug}`;
}

export function ticketBranchName(workflowId, ticketId, ticketSlug) {
	validateWorkflowId(workflowId);
	validateTicketId(ticketId);
	validateImmutableSlug(ticketSlug);
	return `dbz-tickets/${workflowId}/${ticketId}-${ticketSlug}`;
}

export async function assertValidLocalBranchName(cwd, branchName, options = {}) {
	assertSingleLineString(branchName, "branchName");
	const checked = await git(cwd, ["check-ref-format", "--branch", branchName], {
		...options,
		allowNonZero: true,
	});
	if (checked.exitCode !== 0) {
		throw new GitStateError(`'${branchName}' is not a valid local Git branch name.`, {
			details: { branch: branchName },
		});
	}
	return branchName;
}

function parseStatusPorcelain(output) {
	const fields = output.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const statusCodes = [];
	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index];
		if (record.length < 3 || record[2] !== " ") {
			throw new GitStateError("Git returned malformed porcelain worktree status.");
		}
		const code = record.slice(0, 2);
		statusCodes.push(code);
		if (/[RC]/u.test(code)) index += 1;
	}
	return statusCodes;
}

export async function inspectWorktreeStatus(cwd = process.cwd(), options = {}) {
	const identity = await inspectGitProject(cwd, options);
	const result = await git(
		identity.projectRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		options,
	);
	const statusCodes = parseStatusPorcelain(result.stdout);
	return {
		worktreePath: identity.projectRoot,
		headCommit: identity.headCommit,
		headBranch: identity.headRef,
		clean: statusCodes.length === 0,
		entryCount: statusCodes.length,
		statusCodes,
	};
}

export async function assertCleanWorktree(cwd = process.cwd(), options = {}) {
	const status = await inspectWorktreeStatus(cwd, options);
	if (!status.clean) {
		throw new GitStateError(
			`Git worktree '${status.worktreePath}' must be clean before this operation; found ${status.entryCount} changed entr${status.entryCount === 1 ? "y" : "ies"}.`,
			{
				details: {
					worktree_path: status.worktreePath,
					entry_count: status.entryCount,
					status_codes: status.statusCodes,
				},
			},
		);
	}
	return status;
}

function oneObjectId(output, objectFormat, description) {
	const value = output.replace(/\r?\n$/u, "");
	if (value.length === 0 || /[\r\n\0]/u.test(value)) {
		throw new GitStateError(`Git returned an invalid ${description}.`);
	}
	return validateObjectId(objectFormat, value, { name: description });
}

export async function resolveCommit(cwd, revision, options = {}) {
	assertSingleLineString(revision, "revision");
	const identity = await inspectGitProject(cwd, options);
	const result = await git(
		identity.projectRoot,
		["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
		options,
	);
	return oneObjectId(result.stdout, identity.objectFormat, `commit for '${revision}'`);
}

export async function resolveLocalBranchCommit(cwd, branchName, options = {}) {
	const identity = await inspectGitProject(cwd, options);
	await assertValidLocalBranchName(identity.projectRoot, branchName, options);
	const reference = `refs/heads/${branchName}`;
	const existence = await git(
		identity.projectRoot,
		["show-ref", "--verify", "--quiet", reference],
		{ ...options, allowNonZero: true },
	);
	if (existence.exitCode === 1) return null;
	if (existence.exitCode !== 0) {
		throw new GitCommandError(`Git could not inspect local branch '${branchName}'.`, {
			details: { branch: branchName, exit_code: existence.exitCode },
		});
	}
	const result = await git(
		identity.projectRoot,
		["show-ref", "--verify", "--hash", reference],
		options,
	);
	return oneObjectId(result.stdout, identity.objectFormat, `tip of branch '${branchName}'`);
}

export async function assertBranchNamespaceAvailable(cwd, branchName, options = {}) {
	const identity = await inspectGitProject(cwd, options);
	await assertValidLocalBranchName(identity.projectRoot, branchName, options);
	const parts = branchName.split("/");
	for (let length = 1; length < parts.length; length += 1) {
		const ancestor = parts.slice(0, length).join("/");
		if (await resolveLocalBranchCommit(identity.projectRoot, ancestor, options)) {
			throw new GitStateError(
				`Cannot create branch '${branchName}' because existing branch '${ancestor}' conflicts with its ref namespace.`,
				{ details: { branch: branchName, conflicting_ref: `refs/heads/${ancestor}` } },
			);
		}
	}
	const descendants = await git(
		identity.projectRoot,
		["for-each-ref", "--format=%(refname)", `refs/heads/${branchName}/`],
		options,
	);
	const firstDescendant = descendants.stdout.trim().split(/\r?\n/u).find(Boolean);
	if (firstDescendant) {
		throw new GitStateError(
			`Cannot create branch '${branchName}' because existing ref '${firstDescendant}' conflicts with its namespace.`,
			{ details: { branch: branchName, conflicting_ref: firstDescendant } },
		);
	}
	return branchName;
}

function parseWorktreeList(output) {
	const records = [];
	let record = null;
	for (const field of output.split("\0")) {
		if (field === "") {
			if (record !== null) {
				if (typeof record.path !== "string" || typeof record.head !== "string") {
					throw new GitStateError("Git returned an incomplete worktree record.");
				}
				records.push(record);
				record = null;
			}
			continue;
		}
		const separator = field.indexOf(" ");
		const key = separator === -1 ? field : field.slice(0, separator);
		const value = separator === -1 ? true : field.slice(separator + 1);
		if (key === "worktree") {
			if (record !== null) throw new GitStateError("Git returned malformed worktree records.");
			record = { path: value };
			continue;
		}
		if (record === null) throw new GitStateError("Git returned malformed worktree records.");
		if (key === "HEAD") record.head = value;
		else if (key === "branch") record.branchRef = value;
		else if (key === "detached") record.detached = true;
		else if (key === "bare") record.bare = true;
		else if (key === "locked") record.locked = value;
		else if (key === "prunable") record.prunable = value;
	}
	if (record !== null) {
		if (typeof record.path !== "string" || typeof record.head !== "string") {
			throw new GitStateError("Git returned an incomplete worktree record.");
		}
		records.push(record);
	}
	return records.map((item) => ({
		...item,
		path: resolve(item.path),
		branch: typeof item.branchRef === "string" && item.branchRef.startsWith("refs/heads/")
			? item.branchRef.slice("refs/heads/".length)
			: null,
	}));
}

export async function listGitWorktrees(cwd = process.cwd(), options = {}) {
	const identity = await inspectGitProject(cwd, options);
	const result = await git(
		identity.projectRoot,
		["worktree", "list", "--porcelain", "-z"],
		options,
	);
	return parseWorktreeList(result.stdout);
}

export async function assertBranchNotCheckedOut(
	cwd,
	branchName,
	{ allowedWorktreePath, ...options } = {},
) {
	const allowed = allowedWorktreePath === undefined ? null : resolve(allowedWorktreePath);
	const conflicts = (await listGitWorktrees(cwd, options)).filter(
		(worktree) => worktree.branch === branchName && worktree.path !== allowed,
	);
	if (conflicts.length > 0) {
		throw new GitStateError(
			`Branch '${branchName}' is already checked out in another Git worktree.`,
			{
				details: {
					branch: branchName,
					worktree_paths: conflicts.map(({ path }) => path),
				},
			},
		);
	}
	return branchName;
}

export async function assertWorktreeDestinationAvailable(worktreePath) {
	if (
		typeof worktreePath !== "string" ||
		worktreePath.length === 0 ||
		worktreePath.includes("\0") ||
		!isAbsolute(worktreePath) ||
		resolve(worktreePath) !== worktreePath
	) {
		throw new ValidationError("worktreePath must be a normalized absolute path without NUL bytes.");
	}
	let cursor = worktreePath;
	const missing = [];
	while (true) {
		try {
			const entry = await lstat(cursor);
			if (cursor === worktreePath) {
				throw new GitStateError(`Ticket worktree destination '${worktreePath}' already exists.`, {
					details: { worktree_path: worktreePath },
				});
			}
			if (entry.isSymbolicLink() || !entry.isDirectory()) {
				throw new GitStateError("A ticket worktree parent path is not a safe directory.", {
					details: { worktree_path: worktreePath, parent_path: cursor },
				});
			}
			const effective = resolve(await realpath(cursor), ...missing);
			if (effective !== worktreePath) {
				throw new GitStateError("Ticket worktree destination must not traverse symbolic links.", {
					details: { worktree_path: worktreePath, effective_path: effective },
				});
			}
			return worktreePath;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			missing.unshift(cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
			cursor = parent;
		}
	}
}

export async function inspectRegisteredWorktree(cwd, worktreePath, options = {}) {
	const normalized = resolve(worktreePath);
	const worktree = (await listGitWorktrees(cwd, options)).find(({ path }) => path === normalized);
	if (!worktree) {
		throw new GitStateError(`'${normalized}' is not a registered Git worktree.`, {
			details: { worktree_path: normalized },
		});
	}
	return worktree;
}

export async function inspectTicketWorktree(
	cwd,
	worktreePath,
	{ expectedBranch, ...options } = {},
) {
	const registered = await inspectRegisteredWorktree(cwd, worktreePath, options);
	if (expectedBranch !== undefined && registered.branch !== expectedBranch) {
		throw new GitStateError("The registered ticket worktree is attached to an unexpected branch.", {
			details: {
				worktree_path: registered.path,
				expected_branch: expectedBranch,
				actual_branch: registered.branch,
			},
		});
	}
	const status = await inspectWorktreeStatus(registered.path, options);
	if (status.headCommit !== registered.head) {
		throw new GitStateError("The ticket worktree changed while it was being inspected.", {
			details: { worktree_path: registered.path },
		});
	}
	return { ...registered, status };
}

async function isResolvedAncestor(cwd, ancestorCommit, descendantCommit, options = {}) {
	const result = await git(
		cwd,
		["merge-base", "--is-ancestor", ancestorCommit, descendantCommit],
		{ ...options, allowNonZero: true },
	);
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new GitCommandError("Git could not determine commit ancestry.", {
		details: {
			ancestor_commit: ancestorCommit,
			descendant_commit: descendantCommit,
			exit_code: result.exitCode,
		},
	});
}

export async function isCommitAncestor(cwd, ancestor, descendant, options = {}) {
	const [ancestorCommit, descendantCommit] = await Promise.all([
		resolveCommit(cwd, ancestor, options),
		resolveCommit(cwd, descendant, options),
	]);
	return isResolvedAncestor(cwd, ancestorCommit, descendantCommit, options);
}

export async function listCommitsBetween(cwd, fromRevision, toRevision, options = {}) {
	const [fromCommit, toCommit] = await Promise.all([
		resolveCommit(cwd, fromRevision, options),
		resolveCommit(cwd, toRevision, options),
	]);
	const identity = await inspectGitProject(cwd, options);
	const result = await git(
		identity.projectRoot,
		["rev-list", "--reverse", `${fromCommit}..${toCommit}`],
		options,
	);
	const commits = result.stdout.trim().length === 0
		? []
		: result.stdout.trim().split(/\r?\n/u);
	for (const commit of commits) {
		validateObjectId(identity.objectFormat, commit, { name: "Commit in revision range" });
	}
	return { fromCommit, toCommit, commits };
}

async function commitTrailerValues(cwd, commit, key, options) {
	const format = `%(trailers:key=${key},valueonly,unfold,separator=%x00)`;
	const result = await git(
		cwd,
		["show", "--no-patch", `--format=${format}`, commit],
		options,
	);
	const output = result.stdout.replace(/\r?\n$/u, "");
	if (output.length === 0) return [];
	return output.split("\0");
}

export async function inspectTicketCommitTrailers(
	cwd,
	commit,
	{ workflowId, ticketId, ...options } = {},
) {
	validateWorkflowId(workflowId);
	validateTicketId(ticketId);
	const resolvedCommit = await resolveCommit(cwd, commit, options);
	const [workflowValues, ticketValues] = await Promise.all([
		commitTrailerValues(cwd, resolvedCommit, TRAILER_KEYS.workflow, options),
		commitTrailerValues(cwd, resolvedCommit, TRAILER_KEYS.ticket, options),
	]);
	return {
		commit: resolvedCommit,
		workflowValues,
		ticketValues,
		valid:
			workflowValues.length === 1 &&
			workflowValues[0] === workflowId &&
			ticketValues.length === 1 &&
			ticketValues[0] === ticketId,
	};
}

export async function assertTicketCommitTrailers(
	cwd,
	commits,
	{ workflowId, ticketId, allowEmpty = false, ...options } = {},
) {
	if (!Array.isArray(commits)) throw new ValidationError("commits must be an array.");
	if (!allowEmpty && commits.length === 0) {
		throw new GitStateError("At least one ticket commit is required for this operation.");
	}
	const inspections = [];
	for (const commit of commits) {
		inspections.push(await inspectTicketCommitTrailers(cwd, commit, {
			workflowId,
			ticketId,
			...options,
		}));
	}
	const invalid = inspections.filter(({ valid }) => !valid);
	if (invalid.length > 0) {
		throw new GitStateError(
			`Ticket commits must contain exactly one '${TRAILER_KEYS.workflow}: ${workflowId}' and one '${TRAILER_KEYS.ticket}: ${ticketId}' trailer.`,
			{
				details: {
					workflow_id: workflowId,
					ticket_id: ticketId,
					invalid_commits: invalid.map(({ commit, workflowValues, ticketValues }) => ({
						commit,
						workflow_values: workflowValues,
						ticket_values: ticketValues,
					})),
				},
			},
		);
	}
	return inspections;
}

export async function discoverIntegratedTicketCommits(
	cwd,
	{
		fromCommit,
		integrationRef,
		workflowId,
		ticketId,
		requireAny = true,
		...options
	},
) {
	const range = await listCommitsBetween(cwd, fromCommit, integrationRef, options);
	if (!(await isResolvedAncestor(cwd, range.fromCommit, range.toCommit, options))) {
		throw new GitStateError("Integrated-commit discovery requires the starting commit to be contained in the integration ref.", {
			details: { from_commit: range.fromCommit, integration_commit: range.toCommit },
		});
	}
	const matching = [];
	for (const commit of range.commits) {
		const inspected = await inspectTicketCommitTrailers(cwd, commit, {
			workflowId,
			ticketId,
			...options,
		});
		if (inspected.valid) matching.push(commit);
	}
	if (requireAny && matching.length === 0) {
		throw new GitStateError("No integrated commits with the required workflow and ticket trailers were found.", {
			details: {
				from_commit: range.fromCommit,
				integration_commit: range.toCommit,
				workflow_id: workflowId,
				ticket_id: ticketId,
			},
		});
	}
	return {
		fromCommit: range.fromCommit,
		integrationCommit: range.toCommit,
		commits: matching,
	};
}

export async function checkFinalContainment(
	cwd,
	{ deliveredCommit, targetBranch, ...options },
) {
	const targetCommit = await resolveLocalBranchCommit(cwd, targetBranch, options);
	if (targetCommit === null) {
		throw new GitStateError(`Final integration target branch '${targetBranch}' does not exist.`, {
			details: { target_branch: targetBranch },
		});
	}
	const resolvedDelivered = await resolveCommit(cwd, deliveredCommit, options);
	const contained = await isResolvedAncestor(cwd, resolvedDelivered, targetCommit, options);
	return {
		deliveredCommit: resolvedDelivered,
		targetBranch,
		targetCommit,
		contained,
	};
}

export async function assertFinalContainment(cwd, parameters) {
	const containment = await checkFinalContainment(cwd, parameters);
	if (!containment.contained) {
		throw new GitStateError(
			`Target branch '${containment.targetBranch}' does not contain delivered commit '${containment.deliveredCommit}'.`,
			{
				details: {
					target_branch: containment.targetBranch,
					target_commit: containment.targetCommit,
					delivered_commit: containment.deliveredCommit,
				},
			},
		);
	}
	return containment;
}

export const TICKET_COMMIT_TRAILERS = TRAILER_KEYS;
