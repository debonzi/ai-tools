import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import {
	canonicalArtifactFileMode,
	canonicalTimestamp,
	requireArtifactDigest,
	resolveWorkflowArtifactContext,
	storageDescriptor,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import { inspectBaseline } from "./baselines.mjs";
import {
	ERROR_CODES,
	PlanMismatchError,
	RevisionConflictError,
	ValidationError,
	VerificationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	sha256Hex,
} from "./filesystem.mjs";
import { parseFrontmatter, patchFrontmatter } from "./frontmatter.mjs";
import { runGit } from "./git-identity.mjs";
import {
	applyFinalIntegrationPlan,
	createFinalIntegrationPlan,
	GIT_PLAN_OPERATIONS,
} from "./git-plans.mjs";
import {
	assertCleanWorktree,
	assertFinalContainment,
	inspectWorktreeStatus,
	isCommitAncestor,
	resolveLocalBranchCommit,
} from "./git-operations.mjs";
import { indexLevelTwoSections, readLevelTwoSection } from "./markdown.mjs";
import {
	finalizePlan,
	requirePlanAuthorization,
	validateReviewedPlan,
} from "./plans.mjs";
import { isDeliveryTicket, isProjectMutatingTicket } from "./schemas/ticket.mjs";
import { validateVerificationMetadata } from "./schemas/verification.mjs";
import {
	assertWorkflowPhaseTransition,
	validateWorkflowMetadata,
} from "./schemas/workflow.mjs";
import { parseSpecArtifact } from "./specs.mjs";
import { listTicketsInContext } from "./tickets.mjs";
import {
	createVerificationArtifactSource,
	VERIFICATION_REQUIRED_SECTIONS,
} from "./templates/verification.mjs";

export const VERIFICATION_PLAN_OPERATIONS = Object.freeze({
	FINAL_INTEGRATION: "workflow_final_integration",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NON_MANDATORY_STATUSES = new Set(["cancelled", "superseded"]);

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalizeSingleLine(value, name) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
		throw new ValidationError(`${name} must be a non-empty single-line string without NUL bytes.`);
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

function descriptorsMatch(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function criteriaDigest(criteria) {
	return sha256Hex(`${JSON.stringify(criteria)}\n`);
}

export function extractAcceptanceCriteria(source, { path } = {}) {
	const section = readLevelTwoSection(source, "Acceptance Criteria", { path, includeHeading: false });
	const normalized = section.replace(/\r\n?/gu, "\n").trim();
	if (normalized.length === 0) throw new VerificationError("The approved baseline has an empty Acceptance Criteria section.");
	const lines = normalized.split("\n");
	const items = [];
	let current = null;
	for (const line of lines) {
		const match = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u.exec(line);
		if (match !== null) {
			if (current !== null) items.push(current);
			current = match[1].trim();
			continue;
		}
		if (current !== null && /^\s+/u.test(line) && line.trim().length > 0) {
			current = `${current} ${line.trim()}`;
			continue;
		}
		if (line.trim().length > 0 && current === null) items.push(line.trim());
	}
	if (current !== null) items.push(current);
	const criteria = items
		.map((text) => text.replace(/\s+/gu, " ").trim())
		.filter((text) => text.length > 0)
		.map((text, index) => ({ id: `AC-${String(index + 1).padStart(3, "0")}`, text }));
	if (criteria.length === 0) throw new VerificationError("The approved baseline contains no extractable acceptance criteria.");
	return criteria;
}

export function parseVerificationArtifact(source, { path, expectedWorkflowId } = {}) {
	const parsed = parseFrontmatter(source, { path });
	validateVerificationMetadata(parsed.data, { path, expectedWorkflowId });
	const sections = indexLevelTwoSections(source, { path });
	const sectionNames = sections.map(({ title }) => title);
	if (JSON.stringify(sectionNames) !== JSON.stringify(VERIFICATION_REQUIRED_SECTIONS)) {
		throw new VerificationError("verification.md must contain the required canonical level-two sections in order.", {
			details: { path, expected_sections: VERIFICATION_REQUIRED_SECTIONS, actual_sections: sectionNames },
		});
	}
	return { ...parsed, sections };
}

async function inspectSpecInContext(context) {
	const snapshot = await readFileWithDigest(context.paths.spec, { encoding: "utf8" });
	const parsed = parseSpecArtifact(snapshot.data, {
		path: context.paths.spec,
		expectedWorkflowId: context.workflow.id,
	});
	return { ...snapshot, parsed };
}

async function currentWorkflowCommit(context) {
	const branch = context.workflow.metadata.git.workflow_branch;
	const commit = await resolveLocalBranchCommit(context.identity.projectRoot, branch);
	if (commit === null) throw new VerificationError(`Workflow branch '${branch}' does not exist.`);
	return commit;
}

function projectStoragePrefix(context) {
	if (context.storage.mode !== "project") return null;
	const value = relative(context.identity.projectRoot, context.storage.effectivePath);
	if (value.length === 0 || value === ".." || value.startsWith(`..${sep}`) || value.includes("\0")) {
		throw new VerificationError("Project workflow storage is not contained by the Git worktree.");
	}
	return value.split(sep).join("/");
}

async function worktreeContainsOnlyCanonicalProjectChanges(context, status) {
	if (status.clean) return true;
	const prefix = projectStoragePrefix(context);
	if (prefix === null) return false;
	const result = await runGit(
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ cwd: context.identity.projectRoot },
	);
	const records = result.stdout.split("\0");
	if (records.at(-1) === "") records.pop();
	const paths = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4 || record[2] !== " ") return false;
		const code = record.slice(0, 2);
		paths.push(record.slice(3));
		if (/[RC]/u.test(code)) {
			index += 1;
			if (records[index] === undefined) return false;
			paths.push(records[index]);
		}
	}
	return paths.length > 0 && paths.every((path) => path === prefix || path.startsWith(`${prefix}/`));
}

async function inspectVerificationInContext(context, { allowMissing = false } = {}) {
	let snapshot;
	try {
		snapshot = await readFileWithDigest(context.paths.verification, { encoding: "utf8" });
	} catch (error) {
		if (allowMissing && error?.code === "ENOENT") return null;
		if (error?.code === "ENOENT") {
			throw new VerificationError(`Workflow '${context.workflow.id}' has no canonical verification.md artifact.`, {
				code: ERROR_CODES.VERIFICATION_NOT_FOUND,
				details: { path: context.paths.verification },
			});
		}
		throw error;
	}
	const parsed = parseVerificationArtifact(snapshot.data, {
		path: context.paths.verification,
		expectedWorkflowId: context.workflow.id,
	});
	const approved = await baselineCriteria(context, parsed.data.baseline);
	if (criteriaDigest(approved.criteria) !== parsed.data.criteria_sha256) {
		throw new VerificationError("verification.md criteria no longer match the immutable approved baseline.");
	}
	const criteriaSection = readLevelTwoSection(snapshot.data, "Acceptance Criteria", { includeHeading: false });
	for (const criterion of approved.criteria) {
		if (!new RegExp(`^### ${criterion.id}\\s*$`, "mu").test(criteriaSection)) {
			throw new VerificationError(`verification.md is missing criterion evidence block '${criterion.id}'.`);
		}
	}
	const deviations = verificationDeviationsFromSource(snapshot.data);
	const blockingDeviationCount = deviations.filter(({ blocking }) => blocking).length;
	if (blockingDeviationCount !== parsed.data.blocking_deviations) {
		throw new VerificationError("verification.md blocking-deviation metadata does not match its recorded deviation evidence.", {
			details: {
				metadata_count: parsed.data.blocking_deviations,
				evidence_count: blockingDeviationCount,
			},
		});
	}
	if (parsed.data.outcome !== "pending") {
		const evidence = verificationEvidenceFromSource(snapshot.data, approved.criteria);
		if (evidence.mandatoryTicketEvidence.length === 0) {
			throw new VerificationError("Completed verification must retain mandatory-ticket evidence.");
		}
	}
	const spec = await inspectSpecInContext(context);
	const workflowCommit = await currentWorkflowCommit(context);
	const worktreeStatus = await inspectWorktreeStatus(context.identity.projectRoot);
	const worktreeClean = await worktreeContainsOnlyCanonicalProjectChanges(context, worktreeStatus);
	const staleness = deriveVerificationStaleness(parsed.data, {
		workflow: context.workflow.metadata,
		spec: spec.parsed.data,
		workflowCommit,
		worktreeClean,
	});
	return {
		path: context.paths.verification,
		digest: snapshot.digest,
		metadata: parsed.data,
		outcome: parsed.data.outcome,
		baseline: parsed.data.baseline,
		verified_commit: parsed.data.verified_commit,
		stale: staleness.stale,
		staleness,
		deviations,
		sections: parsed.sections.map(({ title, line }) => ({ title, line })),
	};
}

export async function inspectVerification(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return inspectVerificationInContext(context);
}

export function deriveVerificationStaleness(metadata, { workflow, spec, workflowCommit, worktreeClean = true } = {}) {
	validateVerificationMetadata(metadata, { expectedWorkflowId: metadata.workflow_id });
	if (!isPlainObject(workflow) || !isPlainObject(spec)) throw new ValidationError("Verification staleness requires workflow and spec metadata.");
	const reasons = [];
	if (worktreeClean !== true) reasons.push({ code: "worktree_dirty" });
	if (workflow.current_baseline !== metadata.baseline || spec.current_baseline !== metadata.baseline) {
		reasons.push({
			code: "baseline_mismatch",
			verified_baseline: metadata.baseline,
			workflow_baseline: workflow.current_baseline,
			spec_baseline: spec.current_baseline,
		});
	}
	if (spec.status !== "baselined") reasons.push({ code: "baseline_not_active", spec_status: spec.status });
	const projectChanges = workflowCommit !== workflow.git?.base_commit;
	if (projectChanges !== metadata.project_changes) {
		reasons.push({ code: "project_change_classification_changed", verified_project_changes: metadata.project_changes, current_project_changes: projectChanges });
	}
	if (metadata.project_changes && metadata.verified_commit !== workflowCommit) {
		reasons.push({ code: "workflow_commit_changed", verified_commit: metadata.verified_commit, workflow_commit: workflowCommit });
	}
	return { stale: reasons.length > 0, reasons, workflow_commit: workflowCommit };
}

function mandatoryTickets(tickets, { includeVerification = true, excludedIds = [] } = {}) {
	const excluded = new Set(excludedIds);
	return tickets.filter((ticket) => (
		isDeliveryTicket(ticket.metadata) &&
		(includeVerification || ticket.type !== "verification") &&
		!NON_MANDATORY_STATUSES.has(ticket.status) &&
		!excluded.has(ticket.id)
	));
}

async function assertMutatingTicketsIntegrated(context, tickets, workflowCommit) {
	for (const ticket of tickets.filter((candidate) => isProjectMutatingTicket(candidate.metadata))) {
		const commits = ticket.metadata.execution?.acceptance?.integrated_commits;
		if (!Array.isArray(commits) || commits.length === 0) {
			throw new VerificationError(`Mutating ticket '${ticket.id}' has no accepted workflow-integration evidence.`);
		}
		for (const commit of commits) {
			if (!(await isCommitAncestor(context.identity.projectRoot, commit, workflowCommit))) {
				throw new VerificationError(`Integrated commit '${commit}' for ticket '${ticket.id}' is not contained in the workflow branch.`, {
					details: { ticket_id: ticket.id, commit, workflow_commit: workflowCommit },
				});
			}
		}
	}
}

function requireCompletedTickets(tickets, message) {
	const incomplete = tickets.filter(({ status }) => status !== "completed").map(({ id, status }) => ({ id, status }));
	if (incomplete.length > 0) throw new VerificationError(message, { details: { tickets: incomplete } });
}

async function baselineCriteria(context, requestedBaselineId = context.workflow.metadata.current_baseline) {
	const baselineId = requestedBaselineId;
	if (baselineId === null) throw new VerificationError("Verification requires an active approved baseline.");
	const baseline = await inspectBaseline(context.identity, context.workflow.id, baselineId, {
		homeDirectory: context.homeDirectory,
	});
	const snapshot = await readFileWithDigest(baseline.path, { encoding: "utf8" });
	if (snapshot.digest !== baseline.digest) throw new RevisionConflictError(`Baseline '${baselineId}' changed while verification was prepared.`);
	return { baseline, criteria: extractAcceptanceCriteria(snapshot.data, { path: baseline.path }) };
}

function pendingIntegration(projectChanges) {
	return projectChanges
		? {
			required: true,
			status: "pending",
			target_branch: null,
			target_commit: null,
			integrated_at: null,
			validated_at: null,
			validation: null,
		}
		: {
			required: false,
			status: "not-required",
			target_branch: null,
			target_commit: null,
			integrated_at: null,
			validated_at: null,
			validation: null,
		};
}

function expectedExistingDigest(value) {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new ValidationError("expectedVerificationDigest must be null or a lowercase SHA-256 digest.");
	}
	return value;
}

function workflowReplacement(context, source, patches) {
	const replacement = patchFrontmatter(source, patches, { path: context.workflow.path });
	const parsed = parseFrontmatter(replacement, { path: context.workflow.path });
	validateWorkflowMetadata(parsed.data, {
		path: context.workflow.path,
		expectedId: context.workflow.id,
		expectedSlug: context.workflow.slug,
		objectFormat: context.identity.objectFormat,
	});
	indexLevelTwoSections(replacement, { path: context.workflow.path });
	return replacement;
}

async function removeOwnedFile(path, digest) {
	try {
		const current = await readFileWithDigest(path);
		if (current.digest !== digest) return false;
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

async function restoreOwnedFile(path, source, replacementDigest, root) {
	try {
		await atomicWriteFile(path, source, { expectedDigest: replacementDigest, root });
		return true;
	} catch {
		return false;
	}
}

async function writeSynchronized(context, values) {
	const {
		verificationSource,
		expectedVerificationDigest,
		previousVerificationSource,
		workflowSource,
		workflowReplacementSource,
	} = values;
	let verificationWrittenDigest = null;
	let workflowCommitted = false;
	try {
		try {
			const written = await atomicWriteFile(context.paths.verification, verificationSource, {
				expectedDigest: expectedVerificationDigest,
				...(expectedVerificationDigest === null ? { mode: canonicalArtifactFileMode(context.storage) } : {}),
				root: context.storage.effectivePath,
			});
			verificationWrittenDigest = written.digest;
		} catch (error) {
			if (error?.details?.committed === true) verificationWrittenDigest = sha256Hex(verificationSource);
			throw error;
		}
		try {
			await atomicWriteFile(context.workflow.path, workflowReplacementSource, {
				expectedDigest: context.workflow.digest,
				root: context.storage.effectivePath,
			});
		} catch (error) {
			workflowCommitted = error?.details?.committed === true;
			throw error;
		}
	} catch (error) {
		if (workflowCommitted) {
			throw new VerificationError("Verification state committed, but canonical workflow synchronization could not be confirmed; inspect both artifacts before retrying.", {
				details: { committed: true, verification_path: context.paths.verification, workflow_path: context.workflow.path },
				cause: error,
			});
		}
		const restored = verificationWrittenDigest === null
			? true
			: expectedVerificationDigest === null
				? await removeOwnedFile(context.paths.verification, verificationWrittenDigest)
				: await restoreOwnedFile(context.paths.verification, previousVerificationSource, verificationWrittenDigest, context.storage.effectivePath);
		if (!restored) {
			throw new VerificationError("Verification mutation failed and its intermediate artifact could not be restored safely.", {
				details: { verification_path: context.paths.verification },
				cause: error,
			});
		}
		throw error;
	}
	return { verificationSource, workflowSource };
}

export async function startVerification(
	identity,
	workflowId,
	{
		expectedWorkflowDigest,
		expectedVerificationDigest = null,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const verificationDigest = expectedExistingDigest(expectedVerificationDigest);
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
		if (!["execution", "verification"].includes(context.workflow.phase)) {
			throw new VerificationError("Verification can start only from execution or restart while already in verification.", {
				details: { phase: context.workflow.phase },
			});
		}
		const existing = await inspectVerificationInContext(context, { allowMissing: true });
		if ((existing?.digest ?? null) !== verificationDigest) {
			throw new RevisionConflictError("verification.md does not match the expected revision.", {
				details: { expected_digest: verificationDigest, actual_digest: existing?.digest ?? null },
			});
		}
		if (context.workflow.phase === "verification" && existing !== null && !existing.stale && existing.outcome === "pending") {
			return { changed: false, verification: existing, workflow: context.workflow };
		}
		await assertCleanWorktree(context.identity.projectRoot);
		const spec = await inspectSpecInContext(context);
		if (spec.parsed.data.status !== "baselined" || spec.parsed.data.current_baseline !== context.workflow.current_baseline) {
			throw new VerificationError("Verification requires the current workflow baseline to be active and baselined.");
		}
		const tickets = await listTicketsInContext(context);
		const deliveryBeforeVerification = mandatoryTickets(tickets, { includeVerification: false });
		requireCompletedTickets(deliveryBeforeVerification, "All mandatory pre-verification delivery tickets must be completed before verification starts.");
		const verificationTickets = mandatoryTickets(tickets).filter(({ type }) => type === "verification");
		if (verificationTickets.length === 0) throw new VerificationError("At least one active verification ticket is required before verification starts.");
		const workflowCommit = await currentWorkflowCommit(context);
		await assertMutatingTicketsIntegrated(context, deliveryBeforeVerification, workflowCommit);
		const baseline = await baselineCriteria(context);
		const projectChanges = workflowCommit !== context.workflow.metadata.git.base_commit;
		const attempt = (existing?.metadata.attempt ?? 0) + 1;
		const metadata = {
			...(existing?.metadata ?? {}),
			artifact: "verification",
			schema_version: 1,
			workflow_id: workflowId,
			baseline: baseline.baseline.id,
			verified_commit: projectChanges ? workflowCommit : null,
			outcome: "pending",
			verified_at: null,
			attempt,
			criteria_sha256: criteriaDigest(baseline.criteria),
			project_changes: projectChanges,
			blocking_deviations: 0,
			correction_tickets: [],
			integration: pendingIntegration(projectChanges),
			created_at: existing?.metadata.created_at ?? timestamp,
			updated_at: timestamp,
		};
		const verificationSource = createVerificationArtifactSource(metadata, { criteria: baseline.criteria });
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const toPhase = "verification";
		if (context.workflow.phase !== toPhase) assertWorkflowPhaseTransition(context.workflow.phase, toPhase);
		const conditions = context.workflow.conditions.filter((condition) => !["blocked", "awaiting-integration"].includes(condition));
		const nextWorkflow = workflowReplacement(context, workflowSource, [
			...(context.workflow.phase === toPhase ? [] : [{ path: ["phase"], value: toPhase }]),
			{ path: ["conditions"], value: conditions },
			{ path: ["updated_at"], value: timestamp },
		]);
		await writeSynchronized(context, {
			verificationSource,
			expectedVerificationDigest: verificationDigest,
			previousVerificationSource: existing === null ? null : (await readFileWithDigest(existing.path, { encoding: "utf8" })).data,
			workflowSource,
			workflowReplacementSource: nextWorkflow,
		});
		const refreshed = await resolveWorkflowArtifactContext(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		return {
			changed: true,
			workflow: refreshed.workflow,
			verification: await inspectVerificationInContext(refreshed),
			criteria: baseline.criteria,
			mandatory_ticket_ids: mandatoryTickets(tickets).map(({ id }) => id),
		};
	}, { homeDirectory, lockOptions });
}

function normalizeCriterionEvidence(value, criteria) {
	if (!Array.isArray(value)) throw new ValidationError("criterionEvidence must be an array.");
	const byId = new Map();
	for (const entry of value) {
		if (!isPlainObject(entry)) throw new ValidationError("Every criterion evidence entry must be an object.");
		if (!criteria.some(({ id }) => id === entry.id)) throw new ValidationError(`Criterion evidence references unknown criterion '${String(entry.id)}'.`);
		if (byId.has(entry.id)) throw new ValidationError(`Criterion evidence '${entry.id}' is duplicated.`);
		if (!["passed", "failed", "blocked"].includes(entry.outcome)) throw new ValidationError(`Criterion '${entry.id}' outcome must be passed, failed, or blocked.`);
		byId.set(entry.id, {
			id: entry.id,
			outcome: entry.outcome,
			evidence: normalizeSingleLine(entry.evidence, `Criterion '${entry.id}' evidence`),
		});
	}
	const missing = criteria.filter(({ id }) => !byId.has(id)).map(({ id }) => id);
	if (missing.length > 0) throw new VerificationError("Every baseline acceptance criterion requires evidence.", { details: { criterion_ids: missing } });
	return criteria.map(({ id }) => byId.get(id));
}

function normalizeTicketEvidence(value, tickets) {
	if (!Array.isArray(value)) throw new ValidationError("mandatoryTicketEvidence must be an array.");
	const required = new Set(tickets.map(({ id }) => id));
	const byId = new Map();
	for (const entry of value) {
		if (!isPlainObject(entry) || !required.has(entry.ticket_id)) throw new ValidationError(`Mandatory-ticket evidence references unknown ticket '${String(entry?.ticket_id)}'.`);
		if (byId.has(entry.ticket_id)) throw new ValidationError(`Mandatory-ticket evidence '${entry.ticket_id}' is duplicated.`);
		byId.set(entry.ticket_id, {
			ticket_id: entry.ticket_id,
			status: "completed",
			evidence: normalizeSingleLine(entry.evidence, `Ticket '${entry.ticket_id}' evidence`),
		});
	}
	const missing = [...required].filter((id) => !byId.has(id));
	if (missing.length > 0) throw new VerificationError("Every mandatory delivery ticket requires verification evidence.", { details: { ticket_ids: missing } });
	return tickets.map(({ id }) => byId.get(id));
}

function normalizeDeviations(value = []) {
	if (!Array.isArray(value)) throw new ValidationError("deviations must be an array.");
	return value.map((entry, index) => {
		if (!isPlainObject(entry) || typeof entry.blocking !== "boolean") throw new ValidationError(`Deviation ${index + 1} must include a boolean blocking value.`);
		return { description: normalizeSingleLine(entry.description, `Deviation ${index + 1} description`), blocking: entry.blocking };
	});
}

function normalizeCorrectionIds(value, tickets, outcome) {
	if (outcome !== "failed") {
		if (value !== undefined && value.length > 0) throw new ValidationError("correctionTicketIds are valid only for failed verification.");
		return [];
	}
	if (!Array.isArray(value) || value.length === 0) throw new VerificationError("Failed verification requires explicit correction tickets before returning to execution.");
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	const seen = new Set();
	const ids = value.map((id) => {
		const ticket = byId.get(id);
		if (ticket === undefined || !isDeliveryTicket(ticket.metadata) || ticket.status !== "open") {
			throw new VerificationError(`Correction ticket '${String(id)}' must be an open delivery ticket in the same workflow.`);
		}
		if (seen.has(id)) throw new ValidationError(`Correction ticket '${id}' is duplicated.`);
		seen.add(id);
		return id;
	});
	if (!ids.some((id) => byId.get(id).type !== "verification")) {
		throw new VerificationError("Failed verification requires at least one explicit non-verification correction ticket.");
	}
	if (!ids.some((id) => byId.get(id).type === "verification")) {
		throw new VerificationError("Failed verification requires a new open verification ticket for the next pass.");
	}
	return ids;
}

function assertOutcomeMatches(outcome, evidence, deviations) {
	const outcomes = new Set(evidence.map((entry) => entry.outcome));
	const blocking = deviations.filter((entry) => entry.blocking).length;
	if (outcome === "passed" && (outcomes.size !== 1 || !outcomes.has("passed") || blocking > 0)) {
		throw new VerificationError("A passed verification requires every criterion to pass and no blocking deviation.");
	}
	if (outcome === "failed" && !outcomes.has("failed") && blocking === 0) {
		throw new VerificationError("A failed verification requires a failed criterion or blocking deviation.");
	}
	if (outcome === "blocked" && !outcomes.has("blocked")) {
		throw new VerificationError("A blocked verification requires at least one blocked criterion.");
	}
}

export async function recordVerificationOutcome(
	identity,
	workflowId,
	{
		outcome,
		criterionEvidence,
		mandatoryTicketEvidence,
		deviations = [],
		correctionTicketIds,
		expectedWorkflowDigest,
		expectedVerificationDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	if (!["passed", "failed", "blocked"].includes(outcome)) throw new ValidationError("Verification outcome must be passed, failed, or blocked.");
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const verificationDigest = requireArtifactDigest(expectedVerificationDigest, "expectedVerificationDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
		if (context.workflow.phase !== "verification") throw new VerificationError("Verification evidence may be recorded only in the verification phase.");
		const current = await inspectVerificationInContext(context);
		if (current.digest !== verificationDigest) throw new RevisionConflictError("verification.md does not match the expected revision.");
		if (current.outcome !== "pending") throw new VerificationError("Only a pending verification attempt can record a final outcome.");
		if (current.stale) throw new VerificationError("Verification is stale and must restart against the current baseline and workflow commit.", { code: ERROR_CODES.VERIFICATION_STALE, details: current.staleness });
		const baseline = await baselineCriteria(context);
		if (criteriaDigest(baseline.criteria) !== current.metadata.criteria_sha256) throw new VerificationError("Baseline acceptance criteria changed after verification started.", { code: ERROR_CODES.VERIFICATION_STALE });
		const tickets = await listTicketsInContext(context);
		const correctionIds = normalizeCorrectionIds(correctionTicketIds, tickets, outcome);
		const mandatory = mandatoryTickets(tickets, { excludedIds: correctionIds });
		requireCompletedTickets(mandatory, "All mandatory delivery and final-verification tickets must be completed before recording verification evidence.");
		const evidence = normalizeCriterionEvidence(criterionEvidence, baseline.criteria);
		const ticketEvidence = normalizeTicketEvidence(mandatoryTicketEvidence, mandatory);
		const normalizedDeviations = normalizeDeviations(deviations);
		assertOutcomeMatches(outcome, evidence, normalizedDeviations);
		const workflowCommit = await currentWorkflowCommit(context);
		await assertMutatingTicketsIntegrated(context, mandatory, workflowCommit);
		let integration = current.metadata.integration;
		let phase = "verification";
		let conditions = context.workflow.conditions.filter((condition) => !["blocked", "awaiting-integration"].includes(condition));
		if (outcome === "passed" && current.metadata.project_changes) {
			integration = { ...integration, status: "awaiting" };
			conditions.push("awaiting-integration");
		} else if (outcome === "passed") {
			phase = "completed";
			assertWorkflowPhaseTransition(context.workflow.phase, phase);
		} else if (outcome === "failed") {
			phase = "execution";
			assertWorkflowPhaseTransition(context.workflow.phase, phase);
		} else {
			conditions.push("blocked");
		}
		const metadata = {
			...current.metadata,
			outcome,
			verified_at: timestamp,
			blocking_deviations: normalizedDeviations.filter(({ blocking }) => blocking).length,
			correction_tickets: correctionIds,
			integration,
			updated_at: timestamp,
		};
		const verificationSource = createVerificationArtifactSource(metadata, {
			criteria: baseline.criteria,
			criterionEvidence: evidence,
			mandatoryTicketEvidence: ticketEvidence,
			deviations: normalizedDeviations,
		});
		const previousVerificationSource = (await readFileWithDigest(current.path, { encoding: "utf8" })).data;
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const nextWorkflow = workflowReplacement(context, workflowSource, [
			{ path: ["phase"], value: phase },
			{ path: ["conditions"], value: conditions },
			{ path: ["updated_at"], value: timestamp },
		]);
		await writeSynchronized(context, {
			verificationSource,
			expectedVerificationDigest: current.digest,
			previousVerificationSource,
			workflowSource,
			workflowReplacementSource: nextWorkflow,
		});
		const refreshed = await resolveWorkflowArtifactContext(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		return {
			changed: true,
			outcome,
			workflow: refreshed.workflow,
			verification: await inspectVerificationInContext(refreshed),
			correction_ticket_ids: correctionIds,
		};
	}, { homeDirectory, lockOptions });
}

function assertPassedVerification(context, verification) {
	if (context.workflow.phase !== "verification" || !context.workflow.conditions.includes("awaiting-integration")) {
		throw new VerificationError("Final integration requires a verification-phase workflow with the awaiting-integration condition.");
	}
	if (verification.outcome !== "passed" || verification.stale) {
		throw new VerificationError("Final integration requires a current, passed verification.", {
			code: verification.stale ? ERROR_CODES.VERIFICATION_STALE : ERROR_CODES.INVALID_VERIFICATION_STATE,
			details: verification.staleness,
		});
	}
	if (!verification.metadata.project_changes || verification.metadata.integration.status !== "awaiting") {
		throw new VerificationError("Final integration is not awaiting a reviewed target-branch operation.");
	}
}

export async function createWorkflowFinalIntegrationPlan(
	identity,
	workflowId,
	{
		targetBranch,
		expectedWorkflowDigest,
		expectedVerificationDigest,
		homeDirectory = homedir(),
		integrationCwd,
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const verificationDigest = requireArtifactDigest(expectedVerificationDigest, "expectedVerificationDigest");
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	if (context.workflow.digest !== workflowDigest) throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
	const verification = await inspectVerificationInContext(context);
	if (verification.digest !== verificationDigest) throw new RevisionConflictError("verification.md does not match the expected revision.");
	assertPassedVerification(context, verification);
	const gitPlan = await createFinalIntegrationPlan({
		cwd: integrationCwd ?? context.identity.projectRoot,
		workflowId,
		workflowSlug: context.workflow.slug,
		targetBranch: normalizeSingleLine(targetBranch, "targetBranch"),
		...(context.storage.mode === "project"
			? { allowedDirtyRoot: context.storage.effectivePath }
			: {}),
	});
	if (gitPlan.workflow.commit !== verification.verified_commit) {
		throw new VerificationError("The final-integration plan workflow commit does not match the exact verified commit.", {
			code: ERROR_CODES.VERIFICATION_STALE,
			details: { verified_commit: verification.verified_commit, planned_commit: gitPlan.workflow.commit },
		});
	}
	return finalizePlan({
		operation: VERIFICATION_PLAN_OPERATIONS.FINAL_INTEGRATION,
		plan_version: 1,
		identity: identityDescriptor(context.identity),
		home_directory: context.homeDirectory,
		storage: storageDescriptor(context.storage),
		workflow: { id: workflowId, digest: context.workflow.digest, path: context.workflow.path },
		verification: { digest: verification.digest, path: verification.path, verified_commit: verification.verified_commit },
		git_plan: gitPlan,
		changes: gitPlan.changes,
	});
}

function assertFinalPlanContext(plan, context, verification) {
	if (!descriptorsMatch(plan.identity, identityDescriptor(context.identity))) throw new PlanMismatchError("The final-integration plan belongs to a different Git project identity.");
	if (plan.home_directory !== context.homeDirectory || !descriptorsMatch(plan.storage, storageDescriptor(context.storage))) throw new PlanMismatchError("Active workflow storage changed after final integration was reviewed.");
	if (plan.workflow.id !== context.workflow.id || plan.workflow.digest !== context.workflow.digest || plan.workflow.path !== context.workflow.path) throw new PlanMismatchError("Workflow metadata changed after final integration was reviewed.");
	if (plan.verification.digest !== verification.digest || plan.verification.path !== verification.path || plan.verification.verified_commit !== verification.verified_commit) throw new PlanMismatchError("Verification evidence changed after final integration was reviewed.");
	assertPassedVerification(context, verification);
	if (plan.git_plan?.operation !== GIT_PLAN_OPERATIONS.FINAL_INTEGRATION || plan.git_plan.workflow?.commit !== verification.verified_commit) throw new PlanMismatchError("The reviewed final-integration Git plan is inconsistent with verification evidence.");
}

export async function applyWorkflowFinalIntegrationPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	validateReviewedPlan(plan, VERIFICATION_PLAN_OPERATIONS.FINAL_INTEGRATION);
	requirePlanAuthorization(plan, authorization);
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, plan.workflow.id, async (context) => {
		const verification = await inspectVerificationInContext(context);
		assertFinalPlanContext(plan, context, verification);
		const gitResult = await applyFinalIntegrationPlan(plan.git_plan, {
			authorization: { confirmed: true, planDigest: plan.git_plan.plan_digest },
		});
		const previousVerificationSource = (await readFileWithDigest(verification.path, { encoding: "utf8" })).data;
		const metadata = {
			...verification.metadata,
			integration: {
				...verification.metadata.integration,
				status: "integrated",
				target_branch: gitResult.target_branch,
				target_commit: gitResult.target_commit,
				integrated_at: timestamp,
			},
			updated_at: timestamp,
		};
		const baseline = await baselineCriteria(context);
		const evidenceSections = verificationEvidenceFromSource(previousVerificationSource, baseline.criteria);
		const replacement = createVerificationArtifactSource(metadata, evidenceSections);
		await atomicWriteFile(verification.path, replacement, {
			expectedDigest: verification.digest,
			root: context.storage.effectivePath,
		});
		return {
			changed: true,
			git: gitResult,
			verification: await inspectVerificationInContext(context),
			completion_pending: true,
			next_action: "Run required post-integration validation against the exact target commit, then complete the workflow through the guarded completion operation.",
		};
	}, { homeDirectory, lockOptions });
}

function verificationDeviationsFromSource(source) {
	const deviationSection = readLevelTwoSection(source, "Deviations", { includeHeading: false });
	const normalized = deviationSection.replace(/\r\n?/gu, "\n").trim();
	if (normalized === "None.") return [];
	if (normalized.length === 0) throw new VerificationError("Existing deviation evidence is empty.");
	return normalized.split(/\n\n(?=### Deviation )/u).map((block, index) => {
		const match = /^### Deviation ([1-9]\d*)\n\n\*\*Blocking:\*\* (yes|no)\n\n([^\n]+)$/u.exec(block);
		if (match === null || Number(match[1]) !== index + 1 || match[3].trim().length === 0) {
			throw new VerificationError("Existing deviation evidence is malformed.", {
				details: { deviation_index: index + 1 },
			});
		}
		return { blocking: match[2] === "yes", description: match[3].trim() };
	});
}

function verificationEvidenceFromSource(source, criteria) {
	const criteriaSection = readLevelTwoSection(source, "Acceptance Criteria", { includeHeading: false });
	const ticketSection = readLevelTwoSection(source, "Mandatory Tickets", { includeHeading: false });
	const criteriaMaterial = `${criteriaSection.trimEnd()}\n### END\n`;
	const criterionEvidence = criteria.map(({ id }) => {
		const block = new RegExp(`^### ${id}\\s*$([\\s\\S]*?)(?=^### )`, "mu").exec(criteriaMaterial)?.[1] ?? "";
		const outcome = /\*\*Outcome:\*\*\s*(passed|failed|blocked)/u.exec(block)?.[1];
		const evidence = /\*\*Evidence:\*\*\s*([^\n]+)/u.exec(block)?.[1]?.trim();
		if (!outcome || !evidence) throw new VerificationError(`Existing verification evidence for '${id}' is malformed.`);
		return { id, outcome, evidence };
	});
	const ticketMaterial = `${ticketSection.trimEnd()}\n### END\n`;
	const mandatoryTicketEvidence = [...ticketMaterial.matchAll(/^### (T-\d{4,})\s*$([\s\S]*?)(?=^### )/gmu)].map((match) => {
		const evidence = /\*\*Evidence:\*\*\s*([^\n]+)/u.exec(match[2])?.[1]?.trim();
		if (!evidence) throw new VerificationError(`Existing mandatory-ticket evidence for '${match[1]}' is malformed.`);
		return { ticket_id: match[1], status: "completed", evidence };
	});
	return {
		criteria,
		criterionEvidence,
		mandatoryTicketEvidence,
		deviations: verificationDeviationsFromSource(source),
	};
}

function normalizePostIntegrationValidation(value) {
	if (!isPlainObject(value) || value.passed !== true) throw new VerificationError("Workflow completion requires passed post-integration validation evidence.");
	if (!Array.isArray(value.commands) || value.commands.length === 0) throw new VerificationError("Post-integration validation requires at least one command.");
	const commands = value.commands.map((command, index) => normalizeSingleLine(command, `Post-integration validation command ${index + 1}`));
	return {
		passed: true,
		commands,
		evidence: normalizeSingleLine(value.evidence, "Post-integration validation evidence"),
		validated_commit: normalizeSingleLine(value.validated_commit ?? value.validatedCommit, "Post-integration validated commit"),
	};
}

export async function completeWorkflowAfterIntegration(
	identity,
	workflowId,
	postIntegrationValidation,
	{
		expectedWorkflowDigest,
		expectedVerificationDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const verificationDigest = requireArtifactDigest(expectedVerificationDigest, "expectedVerificationDigest");
	const validation = normalizePostIntegrationValidation(postIntegrationValidation);
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
		if (context.workflow.phase !== "verification" || !context.workflow.conditions.includes("awaiting-integration")) throw new VerificationError("Workflow completion requires the awaiting-integration verification state.");
		const verification = await inspectVerificationInContext(context);
		if (verification.digest !== verificationDigest) throw new RevisionConflictError("verification.md does not match the expected revision.");
		if (verification.outcome !== "passed" || verification.stale || verification.metadata.integration.status !== "integrated") throw new VerificationError("Workflow completion requires current passed verification and confirmed target integration.");
		const integration = verification.metadata.integration;
		const containment = await assertFinalContainment(context.identity.projectRoot, {
			deliveredCommit: verification.verified_commit,
			targetBranch: integration.target_branch,
		});
		if (validation.validated_commit !== containment.targetCommit) {
			throw new VerificationError("Post-integration validation evidence is not tied to the current target-branch commit.", {
				details: { validated_commit: validation.validated_commit, target_commit: containment.targetCommit },
			});
		}
		assertWorkflowPhaseTransition(context.workflow.phase, "completed");
		const previousVerificationSource = (await readFileWithDigest(verification.path, { encoding: "utf8" })).data;
		const baseline = await baselineCriteria(context);
		const evidenceSections = verificationEvidenceFromSource(previousVerificationSource, baseline.criteria);
		const metadata = {
			...verification.metadata,
			integration: {
				...integration,
				status: "completed",
				target_commit: containment.targetCommit,
				validated_at: timestamp,
				validation: { commands: validation.commands, evidence: validation.evidence },
			},
			updated_at: timestamp,
		};
		const verificationSource = createVerificationArtifactSource(metadata, evidenceSections);
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const nextWorkflow = workflowReplacement(context, workflowSource, [
			{ path: ["phase"], value: "completed" },
			{ path: ["conditions"], value: [] },
			{ path: ["git", "integrated_commit"], value: containment.targetCommit },
			{ path: ["updated_at"], value: timestamp },
		]);
		await writeSynchronized(context, {
			verificationSource,
			expectedVerificationDigest: verification.digest,
			previousVerificationSource,
			workflowSource,
			workflowReplacementSource: nextWorkflow,
		});
		const refreshed = await resolveWorkflowArtifactContext(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		return {
			changed: true,
			contained: true,
			target_branch: containment.targetBranch,
			target_commit: containment.targetCommit,
			workflow: refreshed.workflow,
			verification: await inspectVerificationInContext(refreshed),
		};
	}, { homeDirectory, lockOptions });
}
