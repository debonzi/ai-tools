import { relative, resolve, sep } from "node:path";
import {
	GitStateError,
	PlanMismatchError,
	ValidationError,
} from "./errors.mjs";
import { sha256Hex } from "./filesystem.mjs";
import { inspectGitProject, runGit } from "./git-identity.mjs";
import {
	assertBranchNamespaceAvailable,
	assertBranchNotCheckedOut,
	assertCleanWorktree,
	assertFinalContainment,
	assertTicketCommitTrailers,
	assertValidLocalBranchName,
	assertWorktreeDestinationAvailable,
	discoverIntegratedTicketCommits,
	inspectTicketWorktree,
	isCommitAncestor,
	listCommitsBetween,
	resolveCommit,
	resolveLocalBranchCommit,
	ticketBranchName,
	workflowBranchName,
} from "./git-operations.mjs";
import {
	finalizePlan,
	requirePlanAuthorization,
	validateReviewedPlan,
} from "./plans.mjs";

export const GIT_PLAN_OPERATIONS = Object.freeze({
	WORKFLOW_BRANCH: "git_workflow_branch",
	TICKET_WORKTREE: "git_ticket_worktree",
	TICKET_WORKTREE_REMOVAL: "git_ticket_worktree_removal",
	TICKET_RECONCILIATION: "git_ticket_reconciliation",
	TICKET_INTEGRATION: "git_ticket_integration",
	FINAL_INTEGRATION: "git_final_integration",
});

function gitOptions(options = {}) {
	return {
		...(options.runGitCommand === undefined ? {} : { runGitCommand: options.runGitCommand }),
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
		cwd,
		...(options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary }),
		...(options.env === undefined ? {} : { env: options.env }),
	});
}

function repositoryIdentity(identity) {
	return {
		project_root: identity.projectRoot,
		project_key: identity.projectKey,
		object_format: identity.objectFormat,
		root_commit: identity.rootCommit,
	};
}

async function assertPlanRepository(plan, cwd, options) {
	const identity = await inspectGitProject(cwd, options);
	const actual = repositoryIdentity(identity);
	const expected = plan.repository;
	if (
		expected?.project_root !== actual.project_root ||
		expected?.project_key !== actual.project_key ||
		expected?.object_format !== actual.object_format ||
		expected?.root_commit !== actual.root_commit
	) {
		throw new PlanMismatchError("The reviewed Git plan does not match the current repository worktree.", {
			details: { expected, actual },
		});
	}
	return identity;
}

function assertExpectedValue(actual, expected, message, details = {}) {
	if (actual !== expected) {
		throw new PlanMismatchError(message, {
			details: { ...details, expected, actual },
		});
	}
}

function authorize(plan, operation, authorization) {
	validateReviewedPlan(plan, operation);
	requirePlanAuthorization(plan, authorization);
}

async function assertHeadMatches(plan, cwd, options) {
	const status = await assertCleanWorktree(cwd, options);
	assertExpectedValue(
		status.headCommit,
		plan.source.head_commit,
		"The Git worktree HEAD changed after the plan was reviewed.",
		{ worktree_path: status.worktreePath },
	);
	assertExpectedValue(
		status.headBranch,
		plan.source.head_branch,
		"The checked-out branch changed after the plan was reviewed.",
		{ worktree_path: status.worktreePath },
	);
	return status;
}

function statusPaths(output) {
	const records = output.split("\0");
	if (records.at(-1) === "") records.pop();
	const paths = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4 || record[2] !== " ") {
			throw new GitStateError("Git returned malformed porcelain worktree status.");
		}
		const code = record.slice(0, 2);
		paths.push(record.slice(3));
		if (/[RC]/u.test(code)) {
			index += 1;
			if (records[index] === undefined) throw new GitStateError("Git returned malformed renamed-path status.");
			paths.push(records[index]);
		}
	}
	return paths;
}

async function inspectAllowedDirtyState(cwd, allowedDirtyRoot, options) {
	const identity = await inspectGitProject(cwd, options);
	const absoluteRoot = resolve(allowedDirtyRoot);
	const relativeRoot = relative(identity.projectRoot, absoluteRoot);
	if (relativeRoot.length === 0 || relativeRoot === ".." || relativeRoot.startsWith(`..${sep}`)) {
		throw new ValidationError("allowedDirtyRoot must be a child directory of the repository worktree.");
	}
	const prefix = relativeRoot.split(sep).join("/");
	const result = await git(
		identity.projectRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		options,
	);
	const paths = statusPaths(result.stdout);
	const unexpected = paths.filter((path) => path !== prefix && !path.startsWith(`${prefix}/`));
	if (unexpected.length > 0) {
		throw new GitStateError("Final integration permits pending project-storage artifacts only; other worktree changes must be resolved first.", {
			details: { allowed_root: absoluteRoot, unexpected_entry_count: unexpected.length },
		});
	}
	return {
		status: {
			worktreePath: identity.projectRoot,
			headCommit: identity.headCommit,
			headBranch: identity.headRef,
			clean: paths.length === 0,
			entryCount: paths.length,
		},
		descriptor: {
			root: absoluteRoot,
			entry_count: paths.length,
			status_sha256: sha256Hex(result.stdout),
		},
	};
}

async function assertFinalSourceMatches(plan, cwd, options) {
	if (plan.source?.allowed_dirty === null || plan.source?.allowed_dirty === undefined) {
		return assertHeadMatches(plan, cwd, options);
	}
	const inspected = await inspectAllowedDirtyState(cwd, plan.source.allowed_dirty.root, options);
	assertExpectedValue(inspected.status.headCommit, plan.source.head_commit, "The Git worktree HEAD changed after the plan was reviewed.");
	assertExpectedValue(inspected.status.headBranch, plan.source.head_branch, "The checked-out branch changed after the plan was reviewed.");
	if (JSON.stringify(inspected.descriptor) !== JSON.stringify(plan.source.allowed_dirty)) {
		throw new PlanMismatchError("Pending project-storage artifact changes changed after final integration was reviewed.", {
			details: { expected: plan.source.allowed_dirty, actual: inspected.descriptor },
		});
	}
	return inspected.status;
}

function assertCommitArgument(value, name) {
	if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
		throw new ValidationError(`${name} must be a non-empty commit ID when provided.`);
	}
}

export async function createWorkflowBranchPlan({
	cwd = process.cwd(),
	workflowId,
	workflowSlug,
	baseRef = "HEAD",
	expectedBaseCommit,
	adoptExistingCommit,
	...options
} = {}) {
	assertCommitArgument(expectedBaseCommit, "expectedBaseCommit");
	assertCommitArgument(adoptExistingCommit, "adoptExistingCommit");
	const gitContext = gitOptions(options);
	const identity = await inspectGitProject(cwd, gitContext);
	const status = await assertCleanWorktree(identity.projectRoot, gitContext);
	const branch = workflowBranchName(workflowId, workflowSlug);
	await assertValidLocalBranchName(identity.projectRoot, branch, gitContext);
	const baseCommit = await resolveCommit(identity.projectRoot, baseRef, gitContext);
	if (expectedBaseCommit !== undefined && baseCommit !== expectedBaseCommit) {
		throw new GitStateError("The workflow branch base ref does not resolve to the expected commit.", {
			details: {
				base_ref: baseRef,
				expected_commit: expectedBaseCommit,
				actual_commit: baseCommit,
			},
		});
	}
	if (status.headCommit !== baseCommit) {
		throw new GitStateError("Workflow branch creation must start from the currently checked-out base commit.", {
			details: { head_commit: status.headCommit, base_ref: baseRef, base_commit: baseCommit },
		});
	}

	const existingCommit = await resolveLocalBranchCommit(identity.projectRoot, branch, gitContext);
	let action;
	if (existingCommit === null) {
		await assertBranchNamespaceAvailable(identity.projectRoot, branch, gitContext);
		action = "create_and_switch";
	} else {
		if (adoptExistingCommit === undefined) {
			throw new GitStateError(
				`Workflow branch '${branch}' already exists; adoption requires its independently validated exact commit.`,
				{ details: { branch, existing_commit: existingCommit } },
			);
		}
		if (existingCommit !== adoptExistingCommit) {
			throw new GitStateError("Existing workflow branch adoption does not match the expected commit.", {
				details: {
					branch,
					expected_commit: adoptExistingCommit,
					actual_commit: existingCommit,
				},
			});
		}
		if (!(await isCommitAncestor(identity.projectRoot, baseCommit, existingCommit, gitContext))) {
			throw new GitStateError("Existing workflow branch does not descend from the selected base commit.", {
				details: { branch, base_commit: baseCommit, existing_commit: existingCommit },
			});
		}
		await assertBranchNotCheckedOut(identity.projectRoot, branch, {
			...gitContext,
			allowedWorktreePath: status.headBranch === branch ? identity.projectRoot : undefined,
		});
		action = status.headBranch === branch ? "adopt_current" : "adopt_and_switch";
	}

	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.WORKFLOW_BRANCH,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action,
		workflow: { id: workflowId, slug: workflowSlug },
		branch,
		base_ref: baseRef,
		base_commit: baseCommit,
		existing_commit: existingCommit,
		source: {
			worktree_path: identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
		},
		changes: action === "adopt_current"
			? []
			: [{ action, branch, commit: existingCommit ?? baseCommit }],
	});
}

export async function applyWorkflowBranchPlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.WORKFLOW_BRANCH, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	const expectedBranch = workflowBranchName(plan.workflow?.id, plan.workflow?.slug);
	assertExpectedValue(plan.branch, expectedBranch, "The workflow branch plan has inconsistent identity data.");
	await assertHeadMatches(plan, cwd, context);
	const currentBase = await resolveCommit(cwd, plan.base_ref, context);
	assertExpectedValue(currentBase, plan.base_commit, "The workflow base ref moved after the plan was reviewed.", {
		base_ref: plan.base_ref,
	});
	const currentBranchCommit = await resolveLocalBranchCommit(cwd, plan.branch, context);
	assertExpectedValue(
		currentBranchCommit,
		plan.existing_commit,
		"The workflow branch state changed after the plan was reviewed.",
		{ branch: plan.branch },
	);

	if (plan.action === "create_and_switch") {
		await assertBranchNamespaceAvailable(cwd, plan.branch, context);
		await git(cwd, ["switch", "-c", plan.branch, plan.base_commit], context);
	} else if (plan.action === "adopt_and_switch") {
		await assertBranchNotCheckedOut(cwd, plan.branch, context);
		await git(cwd, ["switch", plan.branch], context);
	} else if (plan.action !== "adopt_current") {
		throw new PlanMismatchError(`Unsupported workflow branch plan action '${String(plan.action)}'.`);
	}

	const final = await inspectGitProject(cwd, context);
	const expectedCommit = plan.existing_commit ?? plan.base_commit;
	if (final.headRef !== plan.branch || final.headCommit !== expectedCommit) {
		throw new GitStateError("Workflow branch operation did not produce the reviewed branch and commit.", {
			details: {
				expected_branch: plan.branch,
				expected_commit: expectedCommit,
				actual_branch: final.headRef,
				actual_commit: final.headCommit,
			},
		});
	}
	return {
		operation: GIT_PLAN_OPERATIONS.WORKFLOW_BRANCH,
		changed: plan.action !== "adopt_current",
		action: plan.action,
		branch: plan.branch,
		commit: final.headCommit,
		worktree_path: final.projectRoot,
	};
}

export async function createTicketWorktreePlan({
	cwd = process.cwd(),
	worktreePath,
	workflowId,
	workflowSlug,
	ticketId,
	ticketSlug,
	expectedBaseCommit,
	adoptExistingCommit,
	...options
} = {}) {
	assertCommitArgument(expectedBaseCommit, "expectedBaseCommit");
	assertCommitArgument(adoptExistingCommit, "adoptExistingCommit");
	const context = gitOptions(options);
	const identity = await inspectGitProject(cwd, context);
	const status = await assertCleanWorktree(identity.projectRoot, context);
	const workflowBranch = workflowBranchName(workflowId, workflowSlug);
	if (status.headBranch !== workflowBranch) {
		throw new GitStateError(`Ticket worktrees must be created from checked-out workflow branch '${workflowBranch}'.`, {
			details: { expected_branch: workflowBranch, actual_branch: status.headBranch },
		});
	}
	const baseCommit = await resolveLocalBranchCommit(identity.projectRoot, workflowBranch, context);
	if (baseCommit === null) throw new GitStateError(`Workflow branch '${workflowBranch}' does not exist.`);
	if (expectedBaseCommit !== undefined && baseCommit !== expectedBaseCommit) {
		throw new GitStateError("The workflow branch moved from the expected ticket base commit.", {
			details: { expected_commit: expectedBaseCommit, actual_commit: baseCommit },
		});
	}
	await assertWorktreeDestinationAvailable(worktreePath);
	const branch = ticketBranchName(workflowId, ticketId, ticketSlug);
	const existingCommit = await resolveLocalBranchCommit(identity.projectRoot, branch, context);
	let action;
	if (existingCommit === null) {
		await assertBranchNamespaceAvailable(identity.projectRoot, branch, context);
		action = "create_branch_and_worktree";
	} else {
		if (adoptExistingCommit === undefined || existingCommit !== adoptExistingCommit) {
			throw new GitStateError(
				`Ticket branch '${branch}' already exists and does not match an explicitly validated adoption commit.`,
				{
					details: {
						branch,
						expected_commit: adoptExistingCommit ?? null,
						actual_commit: existingCommit,
					},
				},
			);
		}
		if (!(await isCommitAncestor(identity.projectRoot, baseCommit, existingCommit, context))) {
			throw new GitStateError("Existing ticket branch does not descend from the current workflow commit.", {
				details: { branch, base_commit: baseCommit, existing_commit: existingCommit },
			});
		}
		await assertBranchNotCheckedOut(identity.projectRoot, branch, context);
		action = "adopt_branch_into_worktree";
	}

	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.TICKET_WORKTREE,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action,
		workflow: { id: workflowId, slug: workflowSlug, branch: workflowBranch },
		ticket: { id: ticketId, slug: ticketSlug, branch },
		base_commit: baseCommit,
		existing_commit: existingCommit,
		source: {
			worktree_path: identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
		},
		worktree_path: worktreePath,
		changes: [{ action, branch, path: worktreePath, commit: existingCommit ?? baseCommit }],
	});
}

async function cleanupFailedTicketWorktree(plan, context) {
	try {
		const inspected = await inspectTicketWorktree(
			plan.source.worktree_path,
			plan.worktree_path,
			{ ...context, expectedBranch: plan.ticket.branch },
		);
		if (inspected.status.clean) {
			await git(plan.source.worktree_path, ["worktree", "remove", plan.worktree_path], context);
		}
	} catch {}
	if (plan.action === "create_branch_and_worktree") {
		try {
			const branchCommit = await resolveLocalBranchCommit(
				plan.source.worktree_path,
				plan.ticket.branch,
				context,
			);
			if (branchCommit === plan.base_commit) {
				await git(plan.source.worktree_path, ["branch", "-D", plan.ticket.branch], context);
			}
		} catch {}
	}
}

export async function applyTicketWorktreePlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.TICKET_WORKTREE, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	assertExpectedValue(
		plan.workflow?.branch,
		workflowBranchName(plan.workflow?.id, plan.workflow?.slug),
		"The ticket worktree plan has inconsistent workflow identity data.",
	);
	assertExpectedValue(
		plan.ticket?.branch,
		ticketBranchName(plan.workflow?.id, plan.ticket?.id, plan.ticket?.slug),
		"The ticket worktree plan has inconsistent ticket identity data.",
	);
	await assertHeadMatches(plan, cwd, context);
	const baseCommit = await resolveLocalBranchCommit(cwd, plan.workflow.branch, context);
	assertExpectedValue(baseCommit, plan.base_commit, "The workflow branch moved after the ticket worktree plan was reviewed.");
	await assertWorktreeDestinationAvailable(plan.worktree_path);
	const branchCommit = await resolveLocalBranchCommit(cwd, plan.ticket.branch, context);
	assertExpectedValue(branchCommit, plan.existing_commit, "The ticket branch changed after the worktree plan was reviewed.");

	if (plan.action === "create_branch_and_worktree") {
		await assertBranchNamespaceAvailable(cwd, plan.ticket.branch, context);
	} else if (plan.action === "adopt_branch_into_worktree") {
		await assertBranchNotCheckedOut(cwd, plan.ticket.branch, context);
	} else {
		throw new PlanMismatchError(`Unsupported ticket worktree plan action '${String(plan.action)}'.`);
	}

	try {
		const argumentsList = plan.action === "create_branch_and_worktree"
			? ["worktree", "add", "-b", plan.ticket.branch, plan.worktree_path, plan.base_commit]
			: ["worktree", "add", plan.worktree_path, plan.ticket.branch];
		await git(cwd, argumentsList, context);
		const inspected = await inspectTicketWorktree(cwd, plan.worktree_path, {
			...context,
			expectedBranch: plan.ticket.branch,
		});
		const expectedCommit = plan.existing_commit ?? plan.base_commit;
		if (!inspected.status.clean || inspected.head !== expectedCommit) {
			throw new GitStateError("Created ticket worktree does not match the reviewed branch state.");
		}
		return {
			operation: GIT_PLAN_OPERATIONS.TICKET_WORKTREE,
			changed: true,
			action: plan.action,
			branch: plan.ticket.branch,
			commit: inspected.head,
			worktree_path: inspected.path,
		};
	} catch (error) {
		await cleanupFailedTicketWorktree(plan, context);
		throw error;
	}
}

export async function createTicketWorktreeRemovalPlan({
	cwd = process.cwd(),
	worktreePath,
	workflowId,
	ticketId,
	ticketSlug,
	removeBranch = false,
	containedInBranch,
	...options
} = {}) {
	if (typeof removeBranch !== "boolean") throw new ValidationError("removeBranch must be a boolean.");
	const context = gitOptions(options);
	const identity = await inspectGitProject(cwd, context);
	const sourceStatus = await assertCleanWorktree(identity.projectRoot, context);
	const branch = ticketBranchName(workflowId, ticketId, ticketSlug);
	const inspected = await inspectTicketWorktree(identity.projectRoot, worktreePath, {
		...context,
		expectedBranch: branch,
	});
	if (!inspected.status.clean) {
		throw new GitStateError("Ticket worktree must be clean before removal.", {
			details: { worktree_path: inspected.path, entry_count: inspected.status.entryCount },
		});
	}
	let containment = null;
	if (removeBranch) {
		if (typeof containedInBranch !== "string" || containedInBranch.length === 0) {
			throw new ValidationError("containedInBranch is required when removeBranch is true.");
		}
		await assertValidLocalBranchName(identity.projectRoot, containedInBranch, context);
		const containingCommit = await resolveLocalBranchCommit(identity.projectRoot, containedInBranch, context);
		if (containingCommit === null) {
			throw new GitStateError(`Containing branch '${containedInBranch}' does not exist.`);
		}
		if (!(await isCommitAncestor(identity.projectRoot, inspected.head, containingCommit, context))) {
			throw new GitStateError("Ticket branch cannot be deleted because its tip is not integrated into the containing branch.", {
				details: {
					ticket_commit: inspected.head,
					containing_branch: containedInBranch,
					containing_commit: containingCommit,
				},
			});
		}
		containment = { branch: containedInBranch, commit: containingCommit };
	}
	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.TICKET_WORKTREE_REMOVAL,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action: removeBranch ? "remove_worktree_and_branch" : "remove_worktree",
		ticket: { workflow_id: workflowId, id: ticketId, slug: ticketSlug, branch },
		worktree_path: resolve(worktreePath),
		worktree_commit: inspected.head,
		containment,
		source: {
			worktree_path: identity.projectRoot,
			head_commit: sourceStatus.headCommit,
			head_branch: sourceStatus.headBranch,
		},
		changes: [
			{ action: "remove_worktree", path: resolve(worktreePath) },
			...(removeBranch ? [{ action: "delete_branch", branch }] : []),
		],
	});
}

export async function applyTicketWorktreeRemovalPlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.TICKET_WORKTREE_REMOVAL, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	await assertHeadMatches(plan, cwd, context);
	assertExpectedValue(
		plan.ticket?.branch,
		ticketBranchName(plan.ticket?.workflow_id, plan.ticket?.id, plan.ticket?.slug),
		"The removal plan has inconsistent ticket identity data.",
	);
	const inspected = await inspectTicketWorktree(cwd, plan.worktree_path, {
		...context,
		expectedBranch: plan.ticket.branch,
	});
	if (!inspected.status.clean) throw new PlanMismatchError("The ticket worktree became dirty after review.");
	assertExpectedValue(inspected.head, plan.worktree_commit, "The ticket worktree commit changed after review.");
	if (plan.containment !== null) {
		const containingCommit = await resolveLocalBranchCommit(cwd, plan.containment.branch, context);
		assertExpectedValue(containingCommit, plan.containment.commit, "The containing branch moved after removal was reviewed.");
		if (!(await isCommitAncestor(cwd, inspected.head, containingCommit, context))) {
			throw new PlanMismatchError("The reviewed ticket-branch containment no longer holds.");
		}
	}
	await git(cwd, ["worktree", "remove", plan.worktree_path], context);
	if (plan.action === "remove_worktree_and_branch") {
		await git(cwd, ["branch", "-d", plan.ticket.branch], context);
	} else if (plan.action !== "remove_worktree") {
		throw new PlanMismatchError(`Unsupported worktree removal action '${String(plan.action)}'.`);
	}
	return {
		operation: GIT_PLAN_OPERATIONS.TICKET_WORKTREE_REMOVAL,
		changed: true,
		action: plan.action,
		worktree_path: plan.worktree_path,
		branch: plan.ticket.branch,
		branch_deleted: plan.action === "remove_worktree_and_branch",
	};
}

export async function createTicketReconciliationPlan({
	worktreePath,
	workflowId,
	workflowSlug,
	ticketId,
	ticketSlug,
	...options
} = {}) {
	const context = gitOptions(options);
	const identity = await inspectGitProject(worktreePath, context);
	const status = await assertCleanWorktree(identity.projectRoot, context);
	const workflowBranch = workflowBranchName(workflowId, workflowSlug);
	const ticketBranch = ticketBranchName(workflowId, ticketId, ticketSlug);
	if (status.headBranch !== ticketBranch) {
		throw new GitStateError(`Reconciliation must run in the ticket worktree on branch '${ticketBranch}'.`, {
			details: { actual_branch: status.headBranch, worktree_path: status.worktreePath },
		});
	}
	const workflowCommit = await resolveLocalBranchCommit(identity.projectRoot, workflowBranch, context);
	const ticketCommit = await resolveLocalBranchCommit(identity.projectRoot, ticketBranch, context);
	if (workflowCommit === null || ticketCommit === null) {
		throw new GitStateError("Workflow and ticket branches must exist before reconciliation.");
	}
	const ticketRange = await listCommitsBetween(identity.projectRoot, workflowCommit, ticketCommit, context);
	await assertTicketCommitTrailers(identity.projectRoot, ticketRange.commits, {
		workflowId,
		ticketId,
		allowEmpty: true,
		...context,
	});
	const workflowIsAncestor = await isCommitAncestor(identity.projectRoot, workflowCommit, ticketCommit, context);
	const ticketIsAncestor = await isCommitAncestor(identity.projectRoot, ticketCommit, workflowCommit, context);
	const action = workflowIsAncestor
		? "noop"
		: ticketIsAncestor
			? "fast_forward_ticket"
			: "rebase_ticket";
	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.TICKET_RECONCILIATION,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action,
		workflow: { id: workflowId, slug: workflowSlug, branch: workflowBranch, commit: workflowCommit },
		ticket: {
			id: ticketId,
			slug: ticketSlug,
			branch: ticketBranch,
			commit: ticketCommit,
			commits: ticketRange.commits,
		},
		source: {
			worktree_path: identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
		},
		changes: action === "noop" ? [] : [{ action, branch: ticketBranch, onto: workflowCommit }],
	});
}

export async function applyTicketReconciliationPlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.TICKET_RECONCILIATION, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	await assertHeadMatches(plan, cwd, context);
	const workflowCommit = await resolveLocalBranchCommit(cwd, plan.workflow.branch, context);
	const ticketCommit = await resolveLocalBranchCommit(cwd, plan.ticket.branch, context);
	assertExpectedValue(workflowCommit, plan.workflow.commit, "The workflow branch moved after reconciliation was reviewed.");
	assertExpectedValue(ticketCommit, plan.ticket.commit, "The ticket branch moved after reconciliation was reviewed.");
	await assertTicketCommitTrailers(cwd, plan.ticket.commits, {
		workflowId: plan.workflow.id,
		ticketId: plan.ticket.id,
		allowEmpty: true,
		...context,
	});

	if (plan.action === "rebase_ticket") {
		try {
			await git(cwd, ["rebase", plan.workflow.commit], context);
		} catch (error) {
			await git(cwd, ["rebase", "--abort"], context).catch(() => {});
			throw new GitStateError(
				"Ticket reconciliation encountered conflicts; the rebase was aborted and no conflict was resolved silently.",
				{
					details: { ticket_branch: plan.ticket.branch, workflow_branch: plan.workflow.branch },
					cause: error,
				},
			);
		}
	} else if (plan.action === "fast_forward_ticket") {
		await git(cwd, ["merge", "--ff-only", plan.workflow.commit], context);
	} else if (plan.action !== "noop") {
		throw new PlanMismatchError(`Unsupported reconciliation action '${String(plan.action)}'.`);
	}

	const finalTicketCommit = await resolveLocalBranchCommit(cwd, plan.ticket.branch, context);
	if (!(await isCommitAncestor(cwd, plan.workflow.commit, finalTicketCommit, context))) {
		throw new GitStateError("Reconciled ticket branch does not contain the reviewed workflow commit.");
	}
	const finalRange = await listCommitsBetween(cwd, plan.workflow.commit, finalTicketCommit, context);
	await assertTicketCommitTrailers(cwd, finalRange.commits, {
		workflowId: plan.workflow.id,
		ticketId: plan.ticket.id,
		allowEmpty: true,
		...context,
	});
	return {
		operation: GIT_PLAN_OPERATIONS.TICKET_RECONCILIATION,
		changed: plan.action !== "noop",
		action: plan.action,
		workflow_commit: plan.workflow.commit,
		previous_ticket_commit: plan.ticket.commit,
		ticket_commit: finalTicketCommit,
		previous_ticket_commits: plan.ticket.commits,
		ticket_commits: finalRange.commits,
	};
}

export async function createTicketIntegrationPlan({
	cwd = process.cwd(),
	workflowId,
	workflowSlug,
	ticketId,
	ticketSlug,
	...options
} = {}) {
	const context = gitOptions(options);
	const identity = await inspectGitProject(cwd, context);
	const status = await assertCleanWorktree(identity.projectRoot, context);
	const workflowBranch = workflowBranchName(workflowId, workflowSlug);
	const ticketBranch = ticketBranchName(workflowId, ticketId, ticketSlug);
	if (status.headBranch !== workflowBranch) {
		throw new GitStateError(`Ticket integration must run on workflow branch '${workflowBranch}'.`, {
			details: { actual_branch: status.headBranch },
		});
	}
	const workflowCommit = await resolveLocalBranchCommit(identity.projectRoot, workflowBranch, context);
	const ticketCommit = await resolveLocalBranchCommit(identity.projectRoot, ticketBranch, context);
	if (workflowCommit === null || ticketCommit === null) {
		throw new GitStateError("Workflow and ticket branches must exist before integration.");
	}
	if (!(await isCommitAncestor(identity.projectRoot, workflowCommit, ticketCommit, context))) {
		throw new GitStateError("Ticket branch must be reconciled with the current workflow branch before integration.", {
			details: { workflow_commit: workflowCommit, ticket_commit: ticketCommit },
		});
	}
	const range = await listCommitsBetween(identity.projectRoot, workflowCommit, ticketCommit, context);
	await assertTicketCommitTrailers(identity.projectRoot, range.commits, {
		workflowId,
		ticketId,
		...context,
	});
	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.TICKET_INTEGRATION,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action: "fast_forward_workflow",
		workflow: { id: workflowId, slug: workflowSlug, branch: workflowBranch, commit: workflowCommit },
		ticket: {
			id: ticketId,
			slug: ticketSlug,
			branch: ticketBranch,
			commit: ticketCommit,
			commits: range.commits,
		},
		source: {
			worktree_path: identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
		},
		changes: [{ action: "fast_forward", branch: workflowBranch, from: workflowCommit, to: ticketCommit }],
	});
}

export async function applyTicketIntegrationPlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.TICKET_INTEGRATION, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	await assertHeadMatches(plan, cwd, context);
	const workflowCommit = await resolveLocalBranchCommit(cwd, plan.workflow.branch, context);
	const ticketCommit = await resolveLocalBranchCommit(cwd, plan.ticket.branch, context);
	assertExpectedValue(workflowCommit, plan.workflow.commit, "The workflow branch moved after integration was reviewed.");
	assertExpectedValue(ticketCommit, plan.ticket.commit, "The ticket branch moved after integration was reviewed.");
	if (!(await isCommitAncestor(cwd, workflowCommit, ticketCommit, context))) {
		throw new PlanMismatchError("The ticket branch is no longer a fast-forward integration of the workflow branch.");
	}
	await assertTicketCommitTrailers(cwd, plan.ticket.commits, {
		workflowId: plan.workflow.id,
		ticketId: plan.ticket.id,
		...context,
	});
	if (plan.action !== "fast_forward_workflow") {
		throw new PlanMismatchError(`Unsupported ticket integration action '${String(plan.action)}'.`);
	}
	await git(cwd, ["merge", "--ff-only", plan.ticket.commit], context);
	const integrated = await discoverIntegratedTicketCommits(cwd, {
		fromCommit: plan.workflow.commit,
		integrationRef: plan.workflow.branch,
		workflowId: plan.workflow.id,
		ticketId: plan.ticket.id,
		...context,
	});
	if (
		integrated.integrationCommit !== plan.ticket.commit ||
		JSON.stringify(integrated.commits) !== JSON.stringify(plan.ticket.commits)
	) {
		throw new GitStateError("Integrated commit discovery did not match the reviewed ticket commits.", {
			details: {
				expected_commits: plan.ticket.commits,
				actual_commits: integrated.commits,
			},
		});
	}
	return {
		operation: GIT_PLAN_OPERATIONS.TICKET_INTEGRATION,
		changed: true,
		action: plan.action,
		workflow_commit: integrated.integrationCommit,
		integrated_commits: integrated.commits,
	};
}

export async function createFinalIntegrationPlan({
	cwd = process.cwd(),
	workflowId,
	workflowSlug,
	targetBranch,
	allowedDirtyRoot,
	...options
} = {}) {
	const context = gitOptions(options);
	const identity = await inspectGitProject(cwd, context);
	const allowedDirty = allowedDirtyRoot === undefined
		? null
		: await inspectAllowedDirtyState(identity.projectRoot, allowedDirtyRoot, context);
	const status = allowedDirty === null
		? await assertCleanWorktree(identity.projectRoot, context)
		: allowedDirty.status;
	await assertValidLocalBranchName(identity.projectRoot, targetBranch, context);
	const workflowBranch = workflowBranchName(workflowId, workflowSlug);
	if (allowedDirty !== null && status.headBranch !== workflowBranch) {
		throw new GitStateError("Pending project-storage artifacts may be retained only while final integration runs from the workflow branch.");
	}
	if (targetBranch === workflowBranch) {
		throw new ValidationError("Final integration target must differ from the workflow branch.");
	}
	if (status.headBranch !== targetBranch && status.headBranch !== workflowBranch) {
		throw new GitStateError(
			`Final integration planning must run on target branch '${targetBranch}' or workflow branch '${workflowBranch}'.`,
			{ details: { actual_branch: status.headBranch, target_branch: targetBranch, workflow_branch: workflowBranch } },
		);
	}
	const targetCommit = await resolveLocalBranchCommit(identity.projectRoot, targetBranch, context);
	const workflowCommit = await resolveLocalBranchCommit(identity.projectRoot, workflowBranch, context);
	if (targetCommit === null || workflowCommit === null) {
		throw new GitStateError("Workflow and target branches must exist before final integration.");
	}
	const workflowContained = await isCommitAncestor(identity.projectRoot, workflowCommit, targetCommit, context);
	const targetContained = await isCommitAncestor(identity.projectRoot, targetCommit, workflowCommit, context);
	if (!workflowContained && !targetContained) {
		throw new GitStateError(
			"Workflow and target branches have diverged. Reconcile the workflow with the target, then re-run verification before planning final integration.",
			{
				details: {
					workflow_branch: workflowBranch,
					workflow_commit: workflowCommit,
					target_branch: targetBranch,
					target_commit: targetCommit,
				},
			},
		);
	}
	let action;
	if (workflowContained) {
		action = "already_contained";
	} else if (status.headBranch === targetBranch) {
		action = "fast_forward_target";
	} else {
		await assertBranchNotCheckedOut(identity.projectRoot, targetBranch, context);
		action = "fast_forward_target_ref";
	}
	return finalizePlan({
		operation: GIT_PLAN_OPERATIONS.FINAL_INTEGRATION,
		plan_version: 1,
		repository: repositoryIdentity(identity),
		action,
		workflow: { id: workflowId, slug: workflowSlug, branch: workflowBranch, commit: workflowCommit },
		target: { branch: targetBranch, commit: targetCommit },
		source: {
			worktree_path: identity.projectRoot,
			head_commit: status.headCommit,
			head_branch: status.headBranch,
			allowed_dirty: allowedDirty?.descriptor ?? null,
		},
		changes: action === "already_contained"
			? []
			: [{
				action: action === "fast_forward_target_ref" ? "fast_forward_ref" : "fast_forward",
				branch: targetBranch,
				from: targetCommit,
				to: workflowCommit,
			}],
	});
}

export async function applyFinalIntegrationPlan(
	plan,
	{ authorization, ...options } = {},
) {
	authorize(plan, GIT_PLAN_OPERATIONS.FINAL_INTEGRATION, authorization);
	const context = gitOptions(options);
	const cwd = plan.source?.worktree_path;
	await assertPlanRepository(plan, cwd, context);
	await assertFinalSourceMatches(plan, cwd, context);
	const workflowCommit = await resolveLocalBranchCommit(cwd, plan.workflow.branch, context);
	const targetCommit = await resolveLocalBranchCommit(cwd, plan.target.branch, context);
	assertExpectedValue(workflowCommit, plan.workflow.commit, "The workflow branch moved after final integration was reviewed.");
	assertExpectedValue(targetCommit, plan.target.commit, "The target branch moved after final integration was reviewed.");
	if (plan.action === "fast_forward_target" || plan.action === "fast_forward_target_ref") {
		if (!(await isCommitAncestor(cwd, targetCommit, workflowCommit, context))) {
			throw new PlanMismatchError("The reviewed final integration is no longer a fast-forward.");
		}
		if (plan.action === "fast_forward_target") {
			if (plan.source.head_branch !== plan.target.branch) {
				throw new PlanMismatchError("A checked-out target merge plan must originate on the target branch.");
			}
			await git(cwd, ["merge", "--ff-only", plan.workflow.commit], context);
		} else {
			if (plan.source.head_branch !== plan.workflow.branch) {
				throw new PlanMismatchError("A target-ref fast-forward plan must originate on the workflow branch.");
			}
			await assertBranchNotCheckedOut(cwd, plan.target.branch, context);
			await git(cwd, ["update-ref", `refs/heads/${plan.target.branch}`, plan.workflow.commit, plan.target.commit], context);
		}
	} else if (plan.action !== "already_contained") {
		throw new PlanMismatchError(`Unsupported final integration action '${String(plan.action)}'.`);
	}
	const containment = await assertFinalContainment(cwd, {
		deliveredCommit: plan.workflow.commit,
		targetBranch: plan.target.branch,
		...context,
	});
	return {
		operation: GIT_PLAN_OPERATIONS.FINAL_INTEGRATION,
		changed: plan.action === "fast_forward_target" || plan.action === "fast_forward_target_ref",
		action: plan.action,
		workflow_commit: plan.workflow.commit,
		target_branch: plan.target.branch,
		target_commit: containment.targetCommit,
		contained: true,
	};
}
