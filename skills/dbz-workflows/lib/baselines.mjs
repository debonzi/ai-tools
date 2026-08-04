import {
	lstat,
	readdir,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	canonicalArtifactFileMode,
	canonicalTimestamp,
	requireArtifactDigest,
	resolveWorkflowArtifactContext,
	storageDescriptor,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import {
	BaselineError,
	ERROR_CODES,
	PlanMismatchError,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	markdownBodySha256,
	readFileWithDigest,
	resolveWithinRoot,
	sha256Hex,
} from "./filesystem.mjs";
import {
	parseFrontmatter,
	patchFrontmatter,
} from "./frontmatter.mjs";
import { indexLevelTwoSections } from "./markdown.mjs";
import {
	finalizePlan,
	requirePlanAuthorization,
	validateReviewedPlan,
} from "./plans.mjs";
import { validateBaselineMetadata } from "./schemas/baseline.mjs";
import {
	formatSequentialId,
	isSequentialId,
	parseSequentialId,
	validateBaselineId,
} from "./schemas/identifiers.mjs";
import { SPEC_STATUSES } from "./schemas/spec.mjs";
import {
	assertWorkflowPhaseTransition,
	validateWorkflowMetadata,
} from "./schemas/workflow.mjs";
import { createBaselineArtifactSource } from "./templates/baseline.mjs";
import { parseSpecArtifact } from "./specs.mjs";
import {
	listTicketsInContext,
	unresolvedBaselineBlockingTickets,
} from "./tickets.mjs";
import { validateTicketDag } from "./dag.mjs";

export const BASELINE_PLAN_OPERATIONS = Object.freeze({ APPROVAL: "baseline_approval" });
const BASELINE_FILE_PATTERN = /^(B-\d{4,})\.md$/u;

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

function normalizeRationale(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Baseline revision rationale must be a non-empty single-line string.");
	}
	return value.trim();
}

export function parseBaselineArtifact(
	source,
	{ path, expectedId, expectedWorkflowId } = {},
) {
	const parsed = parseFrontmatter(source, { path });
	validateBaselineMetadata(parsed.data, { path, expectedId, expectedWorkflowId });
	indexLevelTwoSections(source, { path });
	const actualDigest = markdownBodySha256(parsed.body);
	if (actualDigest !== parsed.data.body_sha256) {
		throw new BaselineError(`Immutable baseline '${parsed.data.id}' body does not match its approved digest.`, {
			code: ERROR_CODES.BASELINE_IMMUTABILITY_VIOLATION,
			details: {
				path,
				baseline_id: parsed.data.id,
				expected_digest: parsed.data.body_sha256,
				actual_digest: actualDigest,
			},
		});
	}
	return parsed;
}

async function readSpecInContext(context) {
	let snapshot;
	try {
		snapshot = await readFileWithDigest(context.paths.spec, { encoding: "utf8" });
	} catch (error) {
		throw new BaselineError("The canonical spec.md artifact cannot be read for baseline processing.", {
			details: { path: context.paths.spec },
			cause: error,
		});
	}
	const parsed = parseSpecArtifact(snapshot.data, {
		path: context.paths.spec,
		expectedWorkflowId: context.workflow.id,
	});
	return { path: context.paths.spec, digest: snapshot.digest, source: snapshot.data, parsed };
}

async function listBaselinesInContext(context) {
	let entries;
	try {
		entries = await readdir(context.paths.baselines, { withFileTypes: true });
	} catch (error) {
		throw new BaselineError("Canonical baselines directory cannot be listed safely.", { cause: error });
	}
	const baselines = [];
	for (const entry of entries) {
		const match = BASELINE_FILE_PATTERN.exec(entry.name);
		if (match === null) continue;
		let parsedId;
		try {
			parsedId = parseSequentialId(match[1], { prefix: "B", name: "Baseline ID" });
		} catch (error) {
			throw new BaselineError(`Baseline filename '${entry.name}' contains a non-canonical ID.`, { cause: error });
		}
		if (entry.isSymbolicLink() || !entry.isFile()) {
			throw new BaselineError("Canonical baseline path must be a real regular file.", {
				details: { path: resolve(context.paths.baselines, entry.name) },
			});
		}
		const path = resolveWithinRoot(context.paths.baselines, entry.name);
		const snapshot = await readFileWithDigest(path, { encoding: "utf8" });
		const parsed = parseBaselineArtifact(snapshot.data, {
			path,
			expectedId: match[1],
			expectedWorkflowId: context.workflow.id,
		});
		baselines.push({
			id: parsed.data.id,
			source_synthesis_ticket: parsed.data.source_synthesis_ticket,
			body_sha256: parsed.data.body_sha256,
			approved_at: parsed.data.approved_at,
			approved_by: parsed.data.approved_by,
			path,
			digest: snapshot.digest,
			metadata: parsed.data,
			_number: parsedId.number,
		});
	}
	baselines.sort((left, right) => left._number - right._number);
	for (let index = 1; index < baselines.length; index += 1) {
		if (baselines[index - 1].id === baselines[index].id) {
			throw new BaselineError(`Baseline ID '${baselines[index].id}' appears more than once.`);
		}
	}
	return baselines.map(({ _number, ...baseline }) => baseline);
}

export async function listBaselines(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return listBaselinesInContext(context);
}

async function inspectBaselineInContext(context, baselineId) {
	validateBaselineId(baselineId);
	const baseline = (await listBaselinesInContext(context)).find(({ id }) => id === baselineId);
	if (baseline === undefined) {
		throw new BaselineError(`Baseline '${baselineId}' was not found in workflow '${context.workflow.id}'.`, {
			code: ERROR_CODES.BASELINE_NOT_FOUND,
			details: { baseline_id: baselineId, workflow_id: context.workflow.id },
		});
	}
	return baseline;
}

export async function inspectBaseline(
	identity,
	workflowId,
	baselineId,
	{ homeDirectory = homedir() } = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return inspectBaselineInContext(context, baselineId);
}

export function deriveBaselineStalenessData(specMetadata, artifacts = []) {
	if (specMetadata === null || typeof specMetadata !== "object" || Array.isArray(specMetadata)) {
		throw new ValidationError("specMetadata must be an object.");
	}
	if (!SPEC_STATUSES.includes(specMetadata.status)) throw new ValidationError("specMetadata has an invalid status.");
	if (specMetadata.current_baseline !== null && !isSequentialId(specMetadata.current_baseline, "B")) {
		throw new ValidationError("specMetadata current_baseline must be null or a baseline ID.");
	}
	if (!Array.isArray(artifacts)) throw new ValidationError("artifacts must be an array.");
	const baselineActive = specMetadata.status === "baselined" && specMetadata.current_baseline !== null;
	const normalized = artifacts.map((artifact, index) => {
		if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
			throw new ValidationError(`Artifact staleness input at index ${index} must be an object.`);
		}
		if (artifact.spec_baseline !== null && !isSequentialId(artifact.spec_baseline, "B")) {
			throw new ValidationError(`Artifact staleness input at index ${index} has an invalid spec_baseline.`);
		}
		const reasons = [];
		if (artifact.spec_baseline !== null) {
			if (specMetadata.current_baseline === null) reasons.push("no_current_baseline");
			else if (artifact.spec_baseline !== specMetadata.current_baseline) reasons.push("baseline_mismatch");
			if (!baselineActive && artifact.spec_baseline === specMetadata.current_baseline) {
				reasons.push(specMetadata.status === "suspended" ? "baseline_suspended" : "baseline_under_revision");
			}
		}
		if (Array.isArray(artifact.superseded_inputs) && artifact.superseded_inputs.length > 0) {
			reasons.push("superseded_input");
		}
		return {
			id: artifact.id ?? null,
			spec_baseline: artifact.spec_baseline,
			stale: reasons.length > 0,
			reasons,
		};
	});
	return {
		current_baseline: specMetadata.current_baseline,
		spec_status: specMetadata.status,
		baseline_active: baselineActive,
		artifacts: normalized,
		affected_artifact_ids: normalized.filter(({ stale }) => stale).map(({ id }) => id),
	};
}

async function assertCanonicalDiscoveryTicketGate(context, spec) {
	const tickets = await listTicketsInContext(context);
	validateTicketDag(tickets, { workflowId: context.workflow.id });
	const unresolvedResearch = unresolvedBaselineBlockingTickets(tickets);
	if (unresolvedResearch.length > 0) {
		throw new BaselineError("A baseline cannot be approved while baseline-blocking research remains unresolved.", {
			details: { ticket_ids: unresolvedResearch },
		});
	}
	const recordedSynthesisId = spec.parsed.data.last_synthesis_ticket ?? null;
	if (recordedSynthesisId !== null) {
		const recordedSynthesis = tickets.find(({ id }) => id === recordedSynthesisId);
		if (
			recordedSynthesis === undefined ||
			recordedSynthesis.type !== "synthesis" ||
			recordedSynthesis.status !== "completed"
		) {
			throw new BaselineError("The spec's latest synthesis ticket must be a completed canonical synthesis ticket.", {
				details: { source_synthesis_ticket: recordedSynthesisId },
			});
		}
	}
	const activeDiscoveryInputs = tickets.filter((ticket) => (
		(
			(ticket.type === "research" && ticket.research_class === "baseline-blocking") ||
			["question-session", "design"].includes(ticket.type)
		) &&
		!["cancelled", "superseded"].includes(ticket.status)
	));
	const incompleteInputs = activeDiscoveryInputs
		.filter(({ status }) => status !== "completed")
		.map(({ id }) => id);
	if (incompleteInputs.length > 0) {
		throw new BaselineError("A baseline cannot be approved while discovery inputs remain incomplete.", {
			details: { ticket_ids: incompleteInputs },
		});
	}
	if (activeDiscoveryInputs.length === 0) return;
	const synthesisId = recordedSynthesisId;
	const synthesis = tickets.find(({ id }) => id === synthesisId);
	if (synthesis === undefined || synthesis.type !== "synthesis" || synthesis.status !== "completed") {
		throw new BaselineError("Discovery tickets require a completed canonical synthesis ticket before baseline approval.", {
			details: { source_synthesis_ticket: synthesisId },
		});
	}
	const inputIds = new Set(activeDiscoveryInputs.map(({ id }) => id));
	const missingDependencies = [...inputIds].filter((id) => !synthesis.depends_on.includes(id));
	if (missingDependencies.length > 0) {
		throw new BaselineError("The latest synthesis ticket does not depend on every canonical discovery input.", {
			details: { ticket_ids: missingDependencies, synthesis_ticket: synthesis.id },
		});
	}
}

function assertApprovalState(context, spec, sourceSynthesisTicket) {
	if (context.workflow.phase !== "discovery") {
		throw new BaselineError("Baseline approval is allowed only while the workflow is in discovery.", {
			details: { phase: context.workflow.phase },
		});
	}
	if (context.workflow.conditions.includes("blocked")) {
		throw new BaselineError("A blocked workflow cannot approve a baseline until the condition is cleared.");
	}
	if (spec.parsed.data.status !== "draft" && spec.parsed.data.status !== "suspended") {
		throw new BaselineError("Only a draft or suspended working spec can be approved as a new baseline.", {
			details: { status: spec.parsed.data.status },
		});
	}
	if (spec.parsed.data.open_blockers.length > 0) {
		throw new BaselineError("A baseline cannot be approved while the spec has open blockers.", {
			details: { open_blockers: [...spec.parsed.data.open_blockers] },
		});
	}
	if (context.workflow.metadata.current_baseline !== spec.parsed.data.current_baseline) {
		throw new BaselineError("Workflow and spec current_baseline metadata are inconsistent.");
	}
	const lastSynthesisTicket = spec.parsed.data.last_synthesis_ticket ?? null;
	if (lastSynthesisTicket !== sourceSynthesisTicket) {
		throw new BaselineError("Baseline approval must reference the latest synthesis ticket recorded by the spec.", {
			details: {
				expected_source_synthesis_ticket: lastSynthesisTicket,
				actual_source_synthesis_ticket: sourceSynthesisTicket,
			},
		});
	}
	assertWorkflowPhaseTransition(context.workflow.phase, "planning");
}

async function assertBaselinePathAbsent(path) {
	try {
		const entry = await lstat(path);
		throw new BaselineError("Baseline snapshot destination already exists and immutable artifacts are never overwritten.", {
			details: {
				path,
				kind: entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
			},
		});
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
}

export async function createBaselineApprovalPlan(
	identity,
	workflowId,
	{
		expectedWorkflowDigest,
		expectedSpecDigest,
		sourceSynthesisTicket = null,
		homeDirectory = homedir(),
		clock = () => new Date(),
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const specDigest = requireArtifactDigest(expectedSpecDigest, "expectedSpecDigest");
	if (sourceSynthesisTicket !== null && !isSequentialId(sourceSynthesisTicket, "T")) {
		throw new ValidationError("sourceSynthesisTicket must be null or a canonical ticket ID.");
	}
	const timestamp = canonicalTimestamp(clock);
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	if (context.workflow.digest !== workflowDigest) {
		throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
	}
	const spec = await readSpecInContext(context);
	if (spec.digest !== specDigest) throw new RevisionConflictError("Spec does not match the expected revision.");
	assertApprovalState(context, spec, sourceSynthesisTicket);
	await assertCanonicalDiscoveryTicketGate(context, spec);
	const number = context.workflow.metadata.next_baseline_number;
	if (number >= Number.MAX_SAFE_INTEGER) throw new BaselineError("Baseline ID counter is exhausted.");
	const id = formatSequentialId("B", number);
	const path = resolveWithinRoot(context.paths.baselines, `${id}.md`);
	await assertBaselinePathAbsent(path);
	return finalizePlan({
		operation: BASELINE_PLAN_OPERATIONS.APPROVAL,
		plan_version: 1,
		created_at: timestamp,
		identity: identityDescriptor(context.identity),
		home_directory: context.homeDirectory,
		storage: storageDescriptor(context.storage),
		workflow: {
			id: workflowId,
			digest: context.workflow.digest,
			phase_before: context.workflow.phase,
			phase_after: "planning",
			current_baseline_before: context.workflow.metadata.current_baseline,
		},
		spec: {
			path: spec.path,
			digest: spec.digest,
			status_before: spec.parsed.data.status,
			body_sha256: markdownBodySha256(spec.parsed.body),
		},
		baseline: {
			id,
			number,
			path,
			source_synthesis_ticket: sourceSynthesisTicket,
			approved_by: "user",
		},
		counter: { before: number, after: number + 1 },
		changes: [
			{ action: "create_immutable_baseline", path, baseline_id: id },
			{ action: "mark_spec_baselined", path: spec.path, baseline_id: id },
			{ action: "advance_workflow_to_planning", path: context.workflow.path, baseline_id: id },
		],
	});
}

async function assertApprovalPlanState(plan, context) {
	if (!descriptorsMatch(plan.identity, identityDescriptor(context.identity))) {
		throw new PlanMismatchError("The baseline approval plan belongs to a different Git project identity.");
	}
	if (plan.home_directory !== context.homeDirectory) {
		throw new PlanMismatchError("The baseline approval plan was created for a different home directory.");
	}
	if (!descriptorsMatch(plan.storage, storageDescriptor(context.storage))) {
		throw new PlanMismatchError("Active workflow storage changed after baseline approval was reviewed.");
	}
	if (plan.workflow.id !== context.workflow.id || plan.workflow.digest !== context.workflow.digest) {
		throw new PlanMismatchError("Workflow metadata changed after baseline approval was reviewed.");
	}
	const spec = await readSpecInContext(context);
	if (plan.spec.path !== spec.path || plan.spec.digest !== spec.digest) {
		throw new PlanMismatchError("Spec content changed after baseline approval was reviewed.");
	}
	if (plan.spec.body_sha256 !== markdownBodySha256(spec.parsed.body)) {
		throw new PlanMismatchError("Spec body digest changed after baseline approval was reviewed.");
	}
	if (
		(plan.baseline.source_synthesis_ticket !== null && !isSequentialId(plan.baseline.source_synthesis_ticket, "T")) ||
		plan.baseline.approved_by !== "user"
	) {
		throw new PlanMismatchError("Baseline approval plan contains invalid approval metadata.");
	}
	if (
		context.workflow.metadata.next_baseline_number !== plan.counter.before ||
		plan.baseline.number !== plan.counter.before ||
		plan.baseline.id !== formatSequentialId("B", plan.counter.before) ||
		plan.counter.after !== plan.counter.before + 1
	) {
		throw new PlanMismatchError("Baseline approval plan contains inconsistent counter data.");
	}
	const expectedPath = resolveWithinRoot(context.paths.baselines, `${plan.baseline.id}.md`);
	if (plan.baseline.path !== expectedPath) throw new PlanMismatchError("Baseline approval plan contains an invalid snapshot path.");
	assertApprovalState(context, spec, plan.baseline.source_synthesis_ticket);
	await assertCanonicalDiscoveryTicketGate(context, spec);
	await assertBaselinePathAbsent(expectedPath);
	return spec;
}

async function removeOwnedBaseline(path, digest) {
	try {
		const snapshot = await readFileWithDigest(path);
		if (snapshot.digest !== digest) return false;
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

function workflowApprovalReplacement(context, plan, source) {
	const replacement = patchFrontmatter(
		source,
		[
			{ path: ["phase"], value: "planning" },
			{ path: ["conditions"], value: [] },
			{ path: ["current_baseline"], value: plan.baseline.id },
			{ path: ["next_baseline_number"], value: plan.counter.after },
			{ path: ["updated_at"], value: plan.created_at },
		],
		{ path: context.workflow.path },
	);
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

export async function applyBaselineApprovalPlan(
	plan,
	{
		identity,
		homeDirectory = homedir(),
		authorization,
		lockOptions,
	} = {},
) {
	validateReviewedPlan(plan, BASELINE_PLAN_OPERATIONS.APPROVAL);
	requirePlanAuthorization(plan, authorization);
	return withWorkflowArtifactLock(identity, plan.workflow.id, async (context) => {
		const spec = await assertApprovalPlanState(plan, context);
		const baselineMetadata = {
			artifact: "baseline",
			schema_version: 1,
			id: plan.baseline.id,
			workflow_id: plan.workflow.id,
			source_synthesis_ticket: plan.baseline.source_synthesis_ticket,
			body_sha256: plan.spec.body_sha256,
			approved_at: plan.created_at,
			approved_by: "user",
		};
		const baselineSource = createBaselineArtifactSource(baselineMetadata, spec.parsed.body);
		const specPatches = [
			{ path: ["status"], value: "baselined" },
			{ path: ["current_baseline"], value: plan.baseline.id },
			{ path: ["open_blockers"], value: [] },
			{ path: ["updated_at"], value: plan.created_at },
		];
		if (spec.parsed.data.revision !== undefined) {
			specPatches.push({ path: ["revision"], operation: "delete" });
		}
		const specReplacement = patchFrontmatter(spec.source, specPatches, { path: spec.path });
		parseSpecArtifact(specReplacement, { path: spec.path, expectedWorkflowId: plan.workflow.id });
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const workflowReplacement = workflowApprovalReplacement(context, plan, workflowSource);
		let baselineDigest = null;
		let specReplacementDigest = null;
		let workflowCommitted = false;
		try {
			try {
				const written = await atomicWriteFile(plan.baseline.path, baselineSource, {
					expectedDigest: null,
					mode: canonicalArtifactFileMode(context.storage),
					root: context.storage.effectivePath,
				});
				baselineDigest = written.digest;
			} catch (error) {
				if (error?.details?.committed === true) baselineDigest = sha256Hex(baselineSource);
				throw error;
			}
			try {
				const written = await atomicWriteFile(spec.path, specReplacement, {
					expectedDigest: spec.digest,
					root: context.storage.effectivePath,
				});
				specReplacementDigest = written.digest;
			} catch (error) {
				if (error?.details?.committed === true) specReplacementDigest = sha256Hex(specReplacement);
				throw error;
			}
			try {
				await atomicWriteFile(context.workflow.path, workflowReplacement, {
					expectedDigest: context.workflow.digest,
					root: context.storage.effectivePath,
				});
			} catch (error) {
				workflowCommitted = error?.details?.committed === true;
				throw error;
			}
		} catch (error) {
			if (workflowCommitted) {
				throw new BaselineError(
					"Baseline approval committed, but the workflow directory could not be synchronized; inspect the committed artifacts before retrying.",
					{
						details: {
							committed: true,
							baseline_path: plan.baseline.path,
							spec_path: spec.path,
							workflow_path: context.workflow.path,
						},
						cause: error,
					},
				);
			}
			const specRestored = specReplacementDigest === null
				? true
				: await restoreOwnedFile(
					spec.path,
					spec.source,
					specReplacementDigest,
					context.storage.effectivePath,
				);
			const baselineRemoved = baselineDigest === null
				? true
				: await removeOwnedBaseline(plan.baseline.path, baselineDigest);
			if (!specRestored || !baselineRemoved) {
				throw new BaselineError(
					"Baseline approval failed and its owned intermediate changes could not be fully restored; inspect the reported paths before retrying.",
					{
						details: {
							baseline_path: plan.baseline.path,
							baseline_removed: baselineRemoved,
							spec_path: spec.path,
							spec_restored: specRestored,
						},
						cause: error,
					},
				);
			}
			throw error;
		}
		const refreshed = await resolveWorkflowArtifactContext(context.identity, plan.workflow.id, {
			homeDirectory: context.homeDirectory,
		});
		const updatedSpec = await readSpecInContext(refreshed);
		return {
			operation: BASELINE_PLAN_OPERATIONS.APPROVAL,
			changed: true,
			baseline: await inspectBaselineInContext(refreshed, plan.baseline.id),
			spec: {
				path: updatedSpec.path,
				digest: updatedSpec.digest,
				metadata: updatedSpec.parsed.data,
			},
			workflow: refreshed.workflow,
			staleness: deriveBaselineStalenessData(updatedSpec.parsed.data),
		};
	}, { homeDirectory, lockOptions });
}

function workflowRevisionReplacement(context, timestamp, source) {
	const conditions = context.workflow.conditions.filter((condition) => condition !== "awaiting-integration");
	const replacement = patchFrontmatter(
		source,
		[
			{ path: ["phase"], value: "discovery" },
			{ path: ["conditions"], value: conditions },
			{ path: ["updated_at"], value: timestamp },
		],
		{ path: context.workflow.path },
	);
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

export async function beginBaselineRevision(
	identity,
	workflowId,
	{
		status,
		rationale,
		expectedWorkflowDigest,
		expectedSpecDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
		affectedArtifacts = [],
	} = {},
) {
	if (status !== "draft" && status !== "suspended") {
		throw new ValidationError("Baseline revision status must be 'draft' or 'suspended'.");
	}
	const normalizedRationale = normalizeRationale(rationale);
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const specDigest = requireArtifactDigest(expectedSpecDigest, "expectedSpecDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) {
			throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`);
		}
		const spec = await readSpecInContext(context);
		if (spec.digest !== specDigest) throw new RevisionConflictError("Spec does not match the expected revision.");
		if (spec.parsed.data.status !== "baselined" || spec.parsed.data.current_baseline === null) {
			throw new BaselineError("Only a currently baselined spec can begin a baseline revision.", {
				details: { status: spec.parsed.data.status, current_baseline: spec.parsed.data.current_baseline },
			});
		}
		if (context.workflow.metadata.current_baseline !== spec.parsed.data.current_baseline) {
			throw new BaselineError("Workflow and spec current_baseline metadata are inconsistent.");
		}
		if (["completed", "cancelled"].includes(context.workflow.phase)) {
			throw new BaselineError("A terminal workflow cannot begin a baseline revision.");
		}
		if (["execution", "verification"].includes(context.workflow.phase) && status !== "suspended") {
			throw new BaselineError("Execution or verification scope changes must suspend the current baseline.");
		}
		if (context.workflow.phase !== "discovery") {
			assertWorkflowPhaseTransition(context.workflow.phase, "discovery");
		}
		await inspectBaselineInContext(context, spec.parsed.data.current_baseline);
		const revision = {
			from_baseline: spec.parsed.data.current_baseline,
			rationale: normalizedRationale,
			started_at: timestamp,
		};
		const specReplacement = patchFrontmatter(
			spec.source,
			[
				{ path: ["status"], value: status },
				{ path: ["based_on"], value: spec.parsed.data.current_baseline },
				{ path: ["last_synthesis_ticket"], value: null },
				{ path: ["revision"], value: revision },
				{ path: ["updated_at"], value: timestamp },
			],
			{ path: spec.path },
		);
		const revisionSpec = parseSpecArtifact(specReplacement, {
			path: spec.path,
			expectedWorkflowId: workflowId,
		});
		const staleness = deriveBaselineStalenessData(revisionSpec.data, affectedArtifacts);
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const workflowReplacement = workflowRevisionReplacement(context, timestamp, workflowSource);
		let specReplacementDigest = null;
		let workflowCommitted = false;
		try {
			try {
				const written = await atomicWriteFile(spec.path, specReplacement, {
					expectedDigest: spec.digest,
					root: context.storage.effectivePath,
				});
				specReplacementDigest = written.digest;
			} catch (error) {
				if (error?.details?.committed === true) specReplacementDigest = sha256Hex(specReplacement);
				throw error;
			}
			try {
				await atomicWriteFile(context.workflow.path, workflowReplacement, {
					expectedDigest: context.workflow.digest,
					root: context.storage.effectivePath,
				});
			} catch (error) {
				workflowCommitted = error?.details?.committed === true;
				throw error;
			}
		} catch (error) {
			if (workflowCommitted) {
				throw new BaselineError(
					"Baseline revision committed, but the workflow directory could not be synchronized; inspect the committed artifacts before retrying.",
					{
						details: { committed: true, spec_path: spec.path, workflow_path: context.workflow.path },
						cause: error,
					},
				);
			}
			if (specReplacementDigest !== null) {
				const restored = await restoreOwnedFile(
					spec.path,
					spec.source,
					specReplacementDigest,
					context.storage.effectivePath,
				);
				if (!restored) {
					throw new BaselineError("Baseline revision failed and the spec could not be restored safely.", {
						details: { spec_path: spec.path },
						cause: error,
					});
				}
			}
			throw error;
		}
		const refreshed = await resolveWorkflowArtifactContext(context.identity, workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const updatedSpec = await readSpecInContext(refreshed);
		return {
			changed: true,
			workflow: refreshed.workflow,
			spec: {
				path: updatedSpec.path,
				digest: updatedSpec.digest,
				metadata: updatedSpec.parsed.data,
			},
			revision,
			staleness,
		};
	}, { homeDirectory, lockOptions });
}
