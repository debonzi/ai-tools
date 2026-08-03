import { homedir } from "node:os";
import {
	canonicalTimestamp,
	requireArtifactDigest,
	resolveWorkflowArtifactContext,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import { inspectDecision } from "./decisions.mjs";
import {
	ERROR_CODES,
	RevisionConflictError,
	SpecError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
} from "./filesystem.mjs";
import {
	parseFrontmatter,
	patchFrontmatter,
} from "./frontmatter.mjs";
import {
	appendLevelTwoSection,
	listLevelTwoSections,
	replaceLevelTwoSection,
} from "./markdown.mjs";
import { validateSpecMetadata } from "./schemas/spec.mjs";
import { isSequentialId } from "./schemas/identifiers.mjs";

export const SYNTHESIS_INPUT_TYPES = Object.freeze([
	"research",
	"question-session",
	"design",
	"synthesis",
]);

function normalizedBlockers(blockers) {
	if (!Array.isArray(blockers)) throw new ValidationError("openBlockers must be an array of ticket IDs.");
	const seen = new Set();
	return blockers.map((blocker) => {
		if (!isSequentialId(blocker, "T")) {
			throw new ValidationError("Every open blocker must be a canonical ticket ID.");
		}
		if (seen.has(blocker)) throw new ValidationError(`Open blocker '${blocker}' is duplicated.`);
		seen.add(blocker);
		return blocker;
	});
}

function normalizeSectionUpdates(updates) {
	if (!Array.isArray(updates)) throw new ValidationError("Spec section updates must be an array.");
	const seen = new Set();
	return updates.map((update) => {
		if (update === null || typeof update !== "object" || Array.isArray(update)) {
			throw new ValidationError("Each spec section update must be an object.");
		}
		if (
			typeof update.heading !== "string" ||
			update.heading.trim().length === 0 ||
			/[\r\n\0]/u.test(update.heading)
		) {
			throw new ValidationError("Each spec section heading must be a non-empty single-line string.");
		}
		if (typeof update.content !== "string" || update.content.includes("\0")) {
			throw new ValidationError("Each spec section content value must be Markdown without NUL bytes.");
		}
		const heading = update.heading.trim();
		const key = heading.toLocaleLowerCase("en-US").replace(/[\t ]+/gu, " ");
		if (seen.has(key)) throw new ValidationError(`Spec section '${heading}' is updated more than once.`);
		seen.add(key);
		const operation = update.operation ?? "replace";
		if (operation !== "replace" && operation !== "append") {
			throw new ValidationError("Spec section update operation must be 'replace' or 'append'.");
		}
		return { heading, content: update.content, operation };
	});
}

export function parseSpecArtifact(source, { path, expectedWorkflowId } = {}) {
	const parsed = parseFrontmatter(source, { path });
	validateSpecMetadata(parsed.data, { path, expectedWorkflowId });
	const sections = listLevelTwoSections(source, { path });
	return { ...parsed, sections };
}

async function inspectSpecInContext(context) {
	let snapshot;
	try {
		snapshot = await readFileWithDigest(context.paths.spec, { encoding: "utf8" });
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new SpecError(`Workflow '${context.workflow.id}' is missing its canonical spec.md artifact.`, {
				code: ERROR_CODES.SPEC_NOT_FOUND,
				details: { path: context.paths.spec },
			});
		}
		throw error;
	}
	const parsed = parseSpecArtifact(snapshot.data, {
		path: context.paths.spec,
		expectedWorkflowId: context.workflow.id,
	});
	return {
		path: context.paths.spec,
		digest: snapshot.digest,
		metadata: parsed.data,
		sections: parsed.sections.map((section) => ({ ...section })),
	};
}

export async function inspectSpec(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return inspectSpecInContext(context);
}

function assertMutableSpecState(spec, workflow) {
	if (workflow.phase !== "discovery") {
		throw new SpecError("The working spec may be edited only while the workflow is in discovery.", {
			details: { workflow_id: workflow.id, phase: workflow.phase },
		});
	}
	if (spec.metadata.status !== "draft" && spec.metadata.status !== "suspended") {
		throw new SpecError("A baselined spec must enter an explicit baseline revision before its body can change.", {
			details: { workflow_id: workflow.id, status: spec.metadata.status },
		});
	}
}

async function mutateSpec(
	identity,
	workflowId,
	{
		expectedWorkflowDigest,
		expectedSpecDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	},
	mutator,
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const specDigest = requireArtifactDigest(expectedSpecDigest, "expectedSpecDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) {
			throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`, {
				details: { expected_digest: workflowDigest, actual_digest: context.workflow.digest },
			});
		}
		const spec = await inspectSpecInContext(context);
		if (spec.digest !== specDigest) {
			throw new RevisionConflictError(`Spec for workflow '${workflowId}' does not match the expected revision.`, {
				details: { expected_digest: specDigest, actual_digest: spec.digest },
			});
		}
		assertMutableSpecState(spec, context.workflow);
		const source = (await readFileWithDigest(spec.path, { encoding: "utf8" })).data;
		const replacement = await mutator(source, spec, context, timestamp);
		if (replacement === source) return { changed: false, spec };
		parseSpecArtifact(replacement, { path: spec.path, expectedWorkflowId: workflowId });
		await atomicWriteFile(spec.path, replacement, {
			expectedDigest: spec.digest,
			root: context.storage.effectivePath,
		});
		return { changed: true, spec: await inspectSpecInContext(context) };
	}, { homeDirectory, lockOptions });
}

function applySectionUpdates(source, updates, path) {
	let replacement = source;
	for (const update of updates) {
		replacement = update.operation === "append"
			? appendLevelTwoSection(replacement, update.heading, update.content, { path })
			: replaceLevelTwoSection(replacement, update.heading, update.content, { path });
	}
	return replacement;
}

export async function updateSpecDraftSections(identity, workflowId, updates, options = {}) {
	const normalizedUpdates = normalizeSectionUpdates(updates);
	if (normalizedUpdates.length === 0) throw new ValidationError("At least one spec section update is required.");
	return mutateSpec(identity, workflowId, options, (source, spec, _context, timestamp) => {
		const withSections = applySectionUpdates(source, normalizedUpdates, spec.path);
		return patchFrontmatter(withSections, [{ path: ["updated_at"], value: timestamp }], { path: spec.path });
	});
}

export async function setSpecOpenBlockers(identity, workflowId, blockers, options = {}) {
	const normalized = normalizedBlockers(blockers);
	return mutateSpec(identity, workflowId, options, async (source, spec, context, timestamp) => {
		if (normalized.length > 0) {
			const { listTicketsInContext } = await import("./tickets.mjs");
			const tickets = await listTicketsInContext(context);
			const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
			for (const blockerId of normalized) {
				const blocker = byId.get(blockerId);
				if (blocker === undefined) {
					throw new SpecError(`Spec blocker '${blockerId}' is not a canonical workflow ticket.`);
				}
				if (["completed", "cancelled", "superseded"].includes(blocker.status)) {
					throw new SpecError(`Spec blocker '${blockerId}' is terminal and cannot remain open.`);
				}
			}
		}
		if (JSON.stringify(spec.metadata.open_blockers) === JSON.stringify(normalized)) return source;
		return patchFrontmatter(
			source,
			[
				{ path: ["open_blockers"], value: normalized },
				{ path: ["updated_at"], value: timestamp },
			],
			{ path: spec.path },
		);
	});
}

function synthesisProblem(message, details) {
	return new SpecError(message, { code: ERROR_CODES.INVALID_SYNTHESIS_INPUTS, details });
}

function validateTicketIdentity(ticket, workflowId, role) {
	if (ticket === null || typeof ticket !== "object" || Array.isArray(ticket)) {
		throw synthesisProblem(`${role} metadata must be an object.`);
	}
	if (ticket.artifact !== "ticket" || !isSequentialId(ticket.id, "T")) {
		throw synthesisProblem(`${role} must be canonical ticket metadata.`);
	}
	if (ticket.workflow_id !== workflowId) {
		throw synthesisProblem(`${role} '${ticket.id}' belongs to a different workflow.`, {
			ticket_id: ticket.id,
			expected_workflow_id: workflowId,
			actual_workflow_id: ticket.workflow_id,
		});
	}
}

export function validateSynthesisInputs({ workflowId, synthesis, inputs, requiredInputIds }) {
	validateTicketIdentity(synthesis, workflowId, "Synthesis ticket");
	if (synthesis.type !== "synthesis") throw synthesisProblem(`Ticket '${synthesis.id}' is not a synthesis ticket.`);
	if (synthesis.status !== "in-progress") {
		throw synthesisProblem(`Synthesis ticket '${synthesis.id}' must be in-progress before it can update the spec.`, {
			status: synthesis.status,
		});
	}
	if (!Array.isArray(synthesis.depends_on)) {
		throw synthesisProblem(`Synthesis ticket '${synthesis.id}' must declare depends_on as an array.`);
	}
	if (!Array.isArray(inputs) || inputs.length === 0) {
		throw synthesisProblem("A synthesis update requires at least one completed discovery input.");
	}
	const byId = new Map();
	for (const input of inputs) {
		validateTicketIdentity(input, workflowId, "Synthesis input");
		if (byId.has(input.id)) throw synthesisProblem(`Synthesis input '${input.id}' is duplicated.`);
		if (!SYNTHESIS_INPUT_TYPES.includes(input.type)) {
			throw synthesisProblem(`Ticket '${input.id}' has type '${String(input.type)}', which is not a synthesis input type.`);
		}
		if (input.status !== "completed") {
			throw synthesisProblem(`Synthesis input '${input.id}' is not completed.`, { status: input.status });
		}
		if (input.type === "question-session" && Array.isArray(input.unresolved_items) && input.unresolved_items.length > 0) {
			throw synthesisProblem(`Question-session input '${input.id}' still has unresolved required items.`);
		}
		byId.set(input.id, input);
	}
	const dependencySet = new Set();
	for (const dependency of synthesis.depends_on) {
		if (!isSequentialId(dependency, "T")) throw synthesisProblem("Synthesis dependencies must be canonical ticket IDs.");
		if (dependencySet.has(dependency)) throw synthesisProblem(`Synthesis dependency '${dependency}' is duplicated.`);
		dependencySet.add(dependency);
		if (!byId.has(dependency)) {
			throw synthesisProblem(`Synthesis dependency '${dependency}' was not supplied and validated as an input.`);
		}
	}
	for (const inputId of byId.keys()) {
		if (!dependencySet.has(inputId)) {
			throw synthesisProblem(`Synthesis ticket '${synthesis.id}' does not depend on required input '${inputId}'.`);
		}
	}
	if (!Array.isArray(requiredInputIds) || requiredInputIds.length === 0) {
		throw synthesisProblem("requiredInputIds must identify every discovery input in the synthesis wave.");
	}
	const required = requiredInputIds;
	const requiredSet = new Set();
	for (const requiredId of required) {
		if (requiredSet.has(requiredId)) throw synthesisProblem(`Required synthesis input '${String(requiredId)}' is duplicated.`);
		requiredSet.add(requiredId);
		if (!isSequentialId(requiredId, "T") || !dependencySet.has(requiredId) || !byId.has(requiredId)) {
			throw synthesisProblem(`Required synthesis input '${String(requiredId)}' is not a validated dependency.`);
		}
	}
	return {
		synthesis_ticket: synthesis.id,
		input_ids: [...dependencySet],
		required_input_ids: [...required],
	};
}

function validateSynthesisDecisions(workflowId, decisions) {
	if (!Array.isArray(decisions)) throw synthesisProblem("Synthesis decisions must be an array.");
	const byId = new Map();
	for (const decision of decisions) {
		if (
			decision === null ||
			typeof decision !== "object" ||
			decision.metadata?.artifact !== "decision" ||
			!isSequentialId(decision.id, "D") ||
			decision.metadata.workflow_id !== workflowId ||
			decision.status !== "accepted"
		) {
			throw synthesisProblem("Every synthesis decision must be an inspected accepted decision from the same workflow.");
		}
		if (byId.has(decision.id)) throw synthesisProblem(`Synthesis decision '${decision.id}' is duplicated.`);
		byId.set(decision.id, requireArtifactDigest(decision.digest, `Decision '${decision.id}' digest`));
	}
	return byId;
}

async function validateCanonicalSynthesisInputs(context, validation, requiredInputIds) {
	const { listTicketsInContext } = await import("./tickets.mjs");
	const tickets = await listTicketsInContext(context);
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket.metadata]));
	const synthesis = byId.get(validation.synthesis_ticket);
	if (synthesis === undefined) {
		throw synthesisProblem(`Synthesis ticket '${validation.synthesis_ticket}' is not a canonical workflow ticket.`);
	}
	const inputs = validation.input_ids.map((id) => {
		const input = byId.get(id);
		if (input === undefined) throw synthesisProblem(`Synthesis input '${id}' is not a canonical workflow ticket.`);
		return input;
	});
	return {
		validation: validateSynthesisInputs({
			workflowId: context.workflow.id,
			synthesis,
			inputs,
			requiredInputIds,
		}),
		tickets,
	};
}

export async function applySynthesisUpdate(
	identity,
	workflowId,
	{
		synthesis,
		inputs,
		requiredInputIds,
		decisions = [],
		sectionUpdates,
		openBlockers,
	},
	options = {},
) {
	const validation = validateSynthesisInputs({ workflowId, synthesis, inputs, requiredInputIds });
	const decisionDigests = validateSynthesisDecisions(workflowId, decisions);
	const updates = normalizeSectionUpdates(sectionUpdates);
	if (updates.length === 0) throw synthesisProblem("Synthesis must update at least one selected spec section.");
	const blockers = normalizedBlockers(openBlockers);
	const result = await mutateSpec(identity, workflowId, options, async (source, spec, context, timestamp) => {
		const canonical = await validateCanonicalSynthesisInputs(
			context,
			validation,
			requiredInputIds,
		);
		if (JSON.stringify(canonical.validation) !== JSON.stringify(validation)) {
			throw synthesisProblem("Canonical synthesis dependencies changed before the spec update.");
		}
		const canonicalTickets = new Map(canonical.tickets.map((ticket) => [ticket.id, ticket]));
		for (const blockerId of blockers) {
			const blocker = canonicalTickets.get(blockerId);
			if (blocker === undefined) {
				throw synthesisProblem(`Synthesis blocker '${blockerId}' is not a canonical workflow ticket.`);
			}
			if (["completed", "cancelled", "superseded"].includes(blocker.status)) {
				throw synthesisProblem(`Synthesis blocker '${blockerId}' is terminal and cannot remain open.`);
			}
		}
		for (const [decisionId, expectedDigest] of decisionDigests) {
			const decision = await inspectDecision(context.identity, workflowId, decisionId, {
				homeDirectory: context.homeDirectory,
			});
			if (decision.digest !== expectedDigest || decision.status !== "accepted") {
				throw synthesisProblem(`Synthesis decision '${decisionId}' changed before the spec update.`, {
					expected_digest: expectedDigest,
					actual_digest: decision.digest,
					status: decision.status,
				});
			}
		}
		const withSections = applySectionUpdates(source, updates, spec.path);
		return patchFrontmatter(
			withSections,
			[
				{ path: ["open_blockers"], value: blockers },
				{ path: ["last_synthesis_ticket"], value: synthesis.id },
				{ path: ["updated_at"], value: timestamp },
			],
			{ path: spec.path },
		);
	});
	return {
		...result,
		synthesis: {
			...validation,
			decision_ids: [...decisionDigests.keys()],
			sections_changed: updates.map(({ heading, operation }) => ({ heading, operation })),
			open_blockers: blockers,
		},
	};
}
