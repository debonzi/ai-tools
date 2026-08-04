import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	canonicalTimestamp,
	requireArtifactDigest,
	resolveWorkflowArtifactContext,
	storageDescriptor,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import {
	ERROR_CODES,
	IssueAdapterError,
	PlanMismatchError,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";
import { atomicWriteFile, readFileWithDigest, resolveWithinRoot, sha256Hex } from "./filesystem.mjs";
import { checkFinalContainment } from "./git-operations.mjs";
import { parseFrontmatter, patchFrontmatter } from "./frontmatter.mjs";
import {
	finalizePlan,
	requirePlanAuthorization,
	validateReviewedPlan,
} from "./plans.mjs";
import {
	ISSUE_RELATIONS,
	normalizeIssueLinks,
	validateWorkflowMetadata,
} from "./schemas/workflow.mjs";
import { inspectVerification } from "./verification.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ISSUES_SCRIPT = fileURLToPath(new URL("../../dbz-issues/scripts/issues.py", import.meta.url));
const MAX_ISSUES_OUTPUT_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const DEVIATION_RESOLUTION_EFFECTS = Object.freeze([
	"does_not_invalidate_resolution",
	"invalidates_resolution",
]);

export const ISSUE_ADAPTER_PLAN_OPERATIONS = Object.freeze({
	LINK: "issue_workflow_link",
	CLOSE: "issue_workflow_close",
});

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function identityDescriptor(identity) {
	return {
		project_root: identity.projectRoot,
		project_key: identity.projectKey,
		object_format: identity.objectFormat,
		root_commit: identity.rootCommit,
	};
}

function descriptorsMatch(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeIdentifier(value, name) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
		throw new ValidationError(`${name} must be a non-empty single-line identifier.`);
	}
	return value.trim();
}

function issueSnapshot(issue) {
	return sha256Hex(`${JSON.stringify(issue)}\n`);
}

function normalizeDeterminationRationale(value, deviationId) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
		throw new ValidationError(`Deviation determination '${deviationId}' rationale must be a non-empty single-line string.`);
	}
	return value.trim();
}

function deviationEvidence(verification) {
	if (!Array.isArray(verification.deviations)) {
		throw new IssueAdapterError("Current verification inspection did not expose recorded deviation evidence safely.");
	}
	const deviations = verification.deviations.map((deviation, index) => {
		if (!isPlainObject(deviation) || typeof deviation.blocking !== "boolean" || typeof deviation.description !== "string" || deviation.description.trim().length === 0) {
			throw new IssueAdapterError("Current verification contains invalid deviation evidence.");
		}
		return {
			id: `DEV-${String(index + 1).padStart(3, "0")}`,
			blocking: deviation.blocking,
			description: deviation.description.trim(),
		};
	});
	return {
		verification_digest: verification.digest,
		evidence_sha256: sha256Hex(`${JSON.stringify(deviations)}\n`),
		deviations,
	};
}

function normalizeDeviationDetermination(value, issueId, evidence) {
	if (value === undefined || value === null) return null;
	if (!isPlainObject(value)) throw new ValidationError("deviationDetermination must be an object when provided.");
	if (value.issue_id !== issueId) {
		throw new ValidationError(`deviationDetermination must be specific to issue '${issueId}'.`);
	}
	if (typeof value.verification_digest !== "string" || !SHA256_PATTERN.test(value.verification_digest)) {
		throw new ValidationError("deviationDetermination.verification_digest must be a lowercase SHA-256 digest.");
	}
	if (!Array.isArray(value.effects)) throw new ValidationError("deviationDetermination.effects must be an array.");
	const expectedIds = new Set(evidence.deviations.map(({ id }) => id));
	const byId = new Map();
	for (const effect of value.effects) {
		if (!isPlainObject(effect) || !expectedIds.has(effect.deviation_id)) {
			throw new ValidationError(`Deviation determination references unknown deviation '${String(effect?.deviation_id)}'.`);
		}
		if (byId.has(effect.deviation_id)) throw new ValidationError(`Deviation determination '${effect.deviation_id}' is duplicated.`);
		if (!DEVIATION_RESOLUTION_EFFECTS.includes(effect.effect)) {
			throw new ValidationError(`Deviation determination effect must be one of: ${DEVIATION_RESOLUTION_EFFECTS.join(", ")}.`);
		}
		byId.set(effect.deviation_id, {
			deviation_id: effect.deviation_id,
			effect: effect.effect,
			rationale: normalizeDeterminationRationale(effect.rationale, effect.deviation_id),
		});
	}
	return {
		issue_id: issueId,
		verification_digest: value.verification_digest,
		effects: evidence.deviations.flatMap(({ id }) => byId.has(id) ? [byId.get(id)] : []),
	};
}

function evaluateDeviationReview(verification, issueId, value, reasons) {
	const evidence = deviationEvidence(verification);
	const determination = normalizeDeviationDetermination(value, issueId, evidence);
	if (evidence.deviations.length === 0) {
		if (determination !== null) {
			throw new ValidationError("deviationDetermination must be omitted when verification recorded no deviations.");
		}
		return {
			issue_id: issueId,
			status: "no_recorded_deviations",
			...evidence,
			determination: null,
		};
	}
	let status = "not_established";
	if (determination === null) {
		reasons.push({
			code: "deviation_effect_not_established",
			deviation_ids: evidence.deviations.map(({ id }) => id),
		});
	} else if (determination.verification_digest !== evidence.verification_digest) {
		status = "stale_determination";
		reasons.push({
			code: "deviation_determination_stale",
			determined_verification_digest: determination.verification_digest,
			current_verification_digest: evidence.verification_digest,
		});
	} else {
		const determinedIds = new Set(determination.effects.map(({ deviation_id }) => deviation_id));
		const missing = evidence.deviations.map(({ id }) => id).filter((id) => !determinedIds.has(id));
		if (missing.length > 0) {
			reasons.push({ code: "deviation_effect_not_established", deviation_ids: missing });
		} else {
			const invalidating = determination.effects
				.filter(({ effect }) => effect === "invalidates_resolution")
				.map(({ deviation_id }) => deviation_id);
			if (invalidating.length > 0) {
				status = "invalidates_resolution";
				reasons.push({ code: "deviation_invalidates_issue_resolution", deviation_ids: invalidating });
			} else {
				status = "does_not_invalidate_resolution";
			}
		}
	}
	return {
		issue_id: issueId,
		status,
		...evidence,
		determination,
	};
}

function issueRegistryRoot(identity) {
	return resolveWithinRoot(identity.projectRoot, "issues");
}

async function defaultRunIssuesCommand(argumentsList, {
	identity,
	issuesScript = DEFAULT_ISSUES_SCRIPT,
	pythonBinary = "python3",
} = {}) {
	if (!Array.isArray(argumentsList) || argumentsList.some((argument) => typeof argument !== "string")) {
		throw new ValidationError("DBZ Issues adapter arguments must be an array of strings.");
	}
	const root = issueRegistryRoot(identity);
	let stdout;
	try {
		({ stdout } = await execFileAsync(
			pythonBinary,
			[issuesScript, "--root", root, ...argumentsList],
			{
				cwd: identity.projectRoot,
				encoding: "utf8",
				maxBuffer: MAX_ISSUES_OUTPUT_BYTES,
			},
		));
	} catch (error) {
		let diagnostic = null;
		try {
			diagnostic = JSON.parse(error?.stderr ?? "");
		} catch {}
		throw new IssueAdapterError(
			diagnostic?.error?.message ?? "The DBZ Issues CLI operation failed.",
			{
				details: {
					issue_error_code: diagnostic?.error?.code ?? null,
					command: argumentsList[0] ?? null,
				},
				cause: error,
			},
		);
	}
	if (Buffer.byteLength(stdout, "utf8") >= MAX_ISSUES_OUTPUT_BYTES) {
		throw new IssueAdapterError("The DBZ Issues CLI response exceeded the adapter's bounded output limit.");
	}
	let payload;
	try {
		payload = JSON.parse(stdout);
	} catch (error) {
		throw new IssueAdapterError("The DBZ Issues CLI returned malformed JSON.", { cause: error });
	}
	if (!isPlainObject(payload) || payload.ok !== true) throw new IssueAdapterError("The DBZ Issues CLI returned an unsuccessful response.");
	return payload;
}

async function runIssue(argumentsList, options) {
	const runIssuesCommand = options.runIssuesCommand ?? defaultRunIssuesCommand;
	if (typeof runIssuesCommand !== "function") throw new ValidationError("runIssuesCommand must be a function.");
	return runIssuesCommand(argumentsList, options);
}

function validateIssuePayload(payload, issueId) {
	const issue = payload?.issue;
	if (!isPlainObject(issue) || issue.id !== issueId || !["open", "closed"].includes(issue.status) || typeof issue.path !== "string" || !Array.isArray(issue.workflows)) {
		throw new IssueAdapterError("The DBZ Issues CLI returned an invalid issue payload.");
	}
	return issue;
}

export async function inspectLinkedIssue(identity, issueId, options = {}) {
	const normalizedId = normalizeIdentifier(issueId, "issueId");
	const payload = await runIssue(["show", normalizedId], { ...options, identity });
	const issue = validateIssuePayload(payload, normalizedId);
	return {
		...issue,
		registry_root: issueRegistryRoot(identity),
		absolute_path: resolveWithinRoot(issueRegistryRoot(identity), issue.path),
		snapshot: issueSnapshot(issue),
	};
}

function linkForWorkflow(issue, workflowId) {
	return issue.workflows.find((link) => link.id === workflowId) ?? null;
}

export async function createIssueLinkPlan(
	identity,
	workflowId,
	issueId,
	relation,
	{
		expectedWorkflowDigest,
		homeDirectory = homedir(),
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	} = {},
) {
	if (!ISSUE_RELATIONS.includes(relation)) throw new ValidationError(`Issue relation must be one of: ${ISSUE_RELATIONS.join(", ")}.`);
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	if (context.workflow.digest !== workflowDigest) throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
	if (["completed", "cancelled"].includes(context.workflow.phase)) throw new IssueAdapterError("Terminal workflows cannot add or change issue links.");
	const issue = await inspectLinkedIssue(context.identity, issueId, { runIssuesCommand, issuesScript, pythonBinary });
	if (issue.status !== "open") throw new IssueAdapterError(`Closed issue '${issue.id}' is immutable and cannot be linked.`);
	const workflowLink = context.workflow.issues.find((link) => link.id === issue.id) ?? null;
	const issueLink = linkForWorkflow(issue, workflowId);
	const action = workflowLink?.relation === relation && issueLink?.relation === relation ? "noop" : "link";
	return finalizePlan({
		operation: ISSUE_ADAPTER_PLAN_OPERATIONS.LINK,
		plan_version: 1,
		identity: identityDescriptor(context.identity),
		home_directory: context.homeDirectory,
		storage: storageDescriptor(context.storage),
		action,
		workflow: {
			id: workflowId,
			path: context.workflow.path,
			digest: context.workflow.digest,
			previous_link: workflowLink,
		},
		issue: {
			id: issue.id,
			path: issue.absolute_path,
			snapshot: issue.snapshot,
			previous_link: issueLink,
		},
		relation,
		changes: action === "noop" ? [] : [
			{ action: "link_workflow_issue", path: context.workflow.path, issue_id: issue.id, relation },
			{ action: "link_issue_workflow", path: issue.absolute_path, workflow_id: workflowId, relation },
		],
	});
}

async function restoreIssueLink(issueId, workflowId, previousLink, appliedRelation, options) {
	try {
		if (previousLink === null) {
			await runIssue([
				"unlink-workflow",
				issueId,
				"--workflow-id",
				workflowId,
				"--relation",
				appliedRelation,
			], options);
		} else {
			await runIssue([
				"link-workflow",
				issueId,
				"--workflow-id",
				workflowId,
				"--relation",
				previousLink.relation,
			], options);
		}
		return true;
	} catch {
		return false;
	}
}

export async function applyIssueLinkPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		clock = () => new Date(),
		lockOptions,
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	} = {},
) {
	validateReviewedPlan(plan, ISSUE_ADAPTER_PLAN_OPERATIONS.LINK);
	requirePlanAuthorization(plan, authorization);
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, plan.workflow.id, async (context) => {
		if (!descriptorsMatch(plan.identity, identityDescriptor(context.identity)) || plan.home_directory !== context.homeDirectory || !descriptorsMatch(plan.storage, storageDescriptor(context.storage))) {
			throw new PlanMismatchError("The issue-link plan no longer matches the active project and workflow storage.");
		}
		if (context.workflow.path !== plan.workflow.path || context.workflow.digest !== plan.workflow.digest) throw new PlanMismatchError("Workflow metadata changed after the issue link was reviewed.");
		if (["completed", "cancelled"].includes(context.workflow.phase)) throw new PlanMismatchError("The workflow became terminal after the issue link was reviewed.");
		const issueOptions = { identity: context.identity, runIssuesCommand, issuesScript, pythonBinary };
		const issue = await inspectLinkedIssue(context.identity, plan.issue.id, issueOptions);
		if (issue.snapshot !== plan.issue.snapshot || issue.absolute_path !== plan.issue.path || issue.status !== "open") throw new PlanMismatchError("The DBZ issue changed after its workflow link was reviewed.");
		if (plan.action === "noop") return { changed: false, workflow: context.workflow, issue };
		if (plan.action !== "link") throw new PlanMismatchError(`Unsupported issue-link action '${String(plan.action)}'.`);
		const issueResult = await runIssue([
			"link-workflow",
			plan.issue.id,
			"--workflow-id",
			plan.workflow.id,
			"--relation",
			plan.relation,
		], issueOptions);
		const links = normalizeIssueLinks([
			...context.workflow.issues.filter((link) => link.id !== plan.issue.id),
			{ id: plan.issue.id, relation: plan.relation },
		]);
		const source = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const replacement = patchFrontmatter(source, [
			{ path: ["issues"], value: links },
			{ path: ["updated_at"], value: timestamp },
		], { path: context.workflow.path });
		const parsed = parseFrontmatter(replacement, { path: context.workflow.path });
		validateWorkflowMetadata(parsed.data, {
			path: context.workflow.path,
			expectedId: context.workflow.id,
			expectedSlug: context.workflow.slug,
			objectFormat: context.identity.objectFormat,
		});
		try {
			await atomicWriteFile(context.workflow.path, replacement, {
				expectedDigest: context.workflow.digest,
				root: context.storage.effectivePath,
			});
		} catch (error) {
			if (error?.details?.committed === true) {
				throw new IssueAdapterError("Bidirectional issue linking committed, but workflow publication could not be confirmed; inspect both canonical links before retrying.", {
					details: { committed: true, issue_id: plan.issue.id, workflow_id: plan.workflow.id },
					cause: error,
				});
			}
			const restored = await restoreIssueLink(
				plan.issue.id,
				plan.workflow.id,
				plan.issue.previous_link,
				plan.relation,
				issueOptions,
			);
			if (!restored) {
				throw new IssueAdapterError("Workflow issue linking failed and the DBZ issue's previous link could not be restored safely.", {
					details: { issue_id: plan.issue.id, workflow_id: plan.workflow.id },
					cause: error,
				});
			}
			throw error;
		}
		const refreshed = await resolveWorkflowArtifactContext(context.identity, context.workflow.id, { homeDirectory: context.homeDirectory });
		return {
			changed: true,
			workflow: refreshed.workflow,
			issue: validateIssuePayload(issueResult, plan.issue.id),
		};
	}, { homeDirectory, lockOptions });
}

export async function evaluateIssueClosureEligibility(
	identity,
	workflowId,
	issueId,
	{
		homeDirectory = homedir(),
		deviationDetermination,
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	} = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	const issue = await inspectLinkedIssue(context.identity, issueId, { runIssuesCommand, issuesScript, pythonBinary });
	const link = context.workflow.issues.find((candidate) => candidate.id === issue.id) ?? null;
	const reverseLink = linkForWorkflow(issue, workflowId);
	const reasons = [];
	if (link === null || reverseLink === null || link.relation !== reverseLink.relation) reasons.push({ code: "bidirectional_link_missing_or_mismatched" });
	const relation = link?.relation ?? reverseLink?.relation ?? null;
	if (relation !== "resolves") reasons.push({ code: "relation_not_resolves", relation });
	if (issue.status !== "open") reasons.push({ code: "issue_not_open", status: issue.status });
	if (context.workflow.phase === "cancelled") reasons.push({ code: "workflow_cancelled" });
	else if (context.workflow.phase !== "completed") reasons.push({ code: "workflow_not_completed", phase: context.workflow.phase });
	let verification = null;
	let deviationReview = null;
	try {
		verification = await inspectVerification(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		if (verification.outcome !== "passed") reasons.push({ code: "verification_not_passed", outcome: verification.outcome });
		if (verification.stale) reasons.push({ code: "verification_stale", reasons: verification.staleness.reasons });
		if (verification.metadata.blocking_deviations > 0) reasons.push({ code: "blocking_verification_deviation", count: verification.metadata.blocking_deviations });
		deviationReview = evaluateDeviationReview(verification, issue.id, deviationDetermination, reasons);
		if (verification.metadata.project_changes) {
			const integration = verification.metadata.integration;
			if (integration.status !== "completed") reasons.push({ code: "final_integration_not_completed", status: integration.status });
			else {
				const containment = await checkFinalContainment(context.identity.projectRoot, {
					deliveredCommit: verification.verified_commit,
					targetBranch: integration.target_branch,
				});
				if (!containment.contained) reasons.push({ code: "target_branch_missing_delivered_changes", ...containment });
			}
		}
	} catch (error) {
		if (error?.code === ERROR_CODES.VERIFICATION_NOT_FOUND) reasons.push({ code: "verification_missing" });
		else throw error;
	}
	return {
		workflow_id: workflowId,
		issue_id: issue.id,
		relation,
		eligible: reasons.length === 0,
		reasons,
		workflow: context.workflow,
		verification,
		deviation_review: deviationReview,
		issue,
	};
}

export async function createIssueClosurePlan(identity, workflowId, issueId, options = {}) {
	const eligibility = await evaluateIssueClosureEligibility(identity, workflowId, issueId, options);
	if (!eligibility.eligible) {
		throw new IssueAdapterError(`Issue '${eligibility.issue_id}' is not eligible for workflow-driven closure.`, {
			code: ERROR_CODES.ISSUE_CLOSURE_INELIGIBLE,
			details: {
				reasons: eligibility.reasons,
				deviation_review: eligibility.deviation_review,
			},
		});
	}
	return finalizePlan({
		operation: ISSUE_ADAPTER_PLAN_OPERATIONS.CLOSE,
		plan_version: 1,
		identity: identityDescriptor(identity),
		home_directory: resolve(options.homeDirectory ?? homedir()),
		workflow: { id: workflowId, digest: eligibility.workflow.digest, phase: eligibility.workflow.phase },
		verification: {
			digest: eligibility.verification.digest,
			path: eligibility.verification.path,
			verified_commit: eligibility.verification.verified_commit,
		},
		deviation_review: eligibility.deviation_review,
		issue: { id: eligibility.issue.id, path: eligibility.issue.absolute_path, snapshot: eligibility.issue.snapshot },
		relation: eligibility.relation,
		changes: [{ action: "close_issue", path: eligibility.issue.absolute_path, issue_id: eligibility.issue.id }],
	});
}

export async function applyIssueClosurePlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	} = {},
) {
	validateReviewedPlan(plan, ISSUE_ADAPTER_PLAN_OPERATIONS.CLOSE);
	requirePlanAuthorization(plan, authorization);
	if (!descriptorsMatch(plan.identity, identityDescriptor(identity)) || plan.home_directory !== resolve(homeDirectory)) throw new PlanMismatchError("The issue-closure plan belongs to a different project or home directory.");
	const eligibility = await evaluateIssueClosureEligibility(identity, plan.workflow.id, plan.issue.id, {
		homeDirectory,
		deviationDetermination: plan.deviation_review?.determination,
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	});
	if (!eligibility.eligible) throw new PlanMismatchError("Issue closure eligibility changed after confirmation.", { details: { reasons: eligibility.reasons } });
	if (
		eligibility.workflow.digest !== plan.workflow.digest ||
		eligibility.verification.digest !== plan.verification.digest ||
		eligibility.verification.path !== plan.verification.path ||
		!descriptorsMatch(eligibility.deviation_review, plan.deviation_review) ||
		eligibility.issue.snapshot !== plan.issue.snapshot ||
		eligibility.issue.absolute_path !== plan.issue.path
	) {
		throw new PlanMismatchError("Workflow, verification, deviation evidence, determination, or issue state changed after closure was reviewed.");
	}
	const payload = await runIssue(["close", plan.issue.id], {
		identity,
		runIssuesCommand,
		issuesScript,
		pythonBinary,
	});
	return {
		changed: true,
		closed: true,
		issue: validateIssuePayload(payload, plan.issue.id),
		workflow_id: plan.workflow.id,
	};
}

export { DEFAULT_ISSUES_SCRIPT };
