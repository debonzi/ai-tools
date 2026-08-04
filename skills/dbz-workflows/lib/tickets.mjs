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
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import {
	assertContextBudget,
	evaluateContextBudget,
	extractContextReferences,
} from "./context-budget.mjs";
import {
	calculateActionableTickets,
	deriveTicketStaleness,
	validateTicketDag,
} from "./dag.mjs";
import { listDecisions } from "./decisions.mjs";
import {
	ERROR_CODES,
	RevisionConflictError,
	TicketError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	resolveWithinRoot,
	sha256Hex,
} from "./filesystem.mjs";
import {
	parseFrontmatter,
	patchFrontmatter,
} from "./frontmatter.mjs";
import {
	listLevelTwoSections,
	readLevelTwoSection,
} from "./markdown.mjs";
import {
	formatSequentialId,
	parseSequentialId,
	validateTicketId,
} from "./schemas/identifiers.mjs";
import { parseSpecArtifact } from "./specs.mjs";
import {
	assertTicketStatusTransition,
	defaultTicketExecution,
	isBaselineBlockingResearch,
	isDeliveryTicket,
	normalizeTicketMetadata,
	requiredTicketSections,
	ticketCreationPhases,
	TERMINAL_TICKET_STATUSES,
	TICKET_TYPES,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";
import { validateWorkflowMetadata } from "./schemas/workflow.mjs";
import { createTicketArtifactSource } from "./templates/tickets/index.mjs";
import { generateImmutableSlug } from "./workflows.mjs";

const TICKET_FILE_PATTERN = /^(T-\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;

function normalizeTitle(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Ticket title must be a non-empty single-line string without NUL bytes.");
	}
	return value.trim();
}

function normalizeRationale(value, name = "rationale") {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError(`${name} must be a non-empty single-line string without NUL bytes.`);
	}
	return value.trim();
}

function ticketFilename(id, slug) {
	validateTicketId(id);
	return `${id}-${slug}.md`;
}

function normalizedHeading(value) {
	return value.trim().replace(/[\t ]+/gu, " ").toLocaleLowerCase("en-US");
}

export function validateTicketContract(source, metadata, { path } = {}) {
	const sections = listLevelTwoSections(source, { path });
	const required = requiredTicketSections(metadata.type);
	const actualByName = new Map(sections.map((section, index) => [normalizedHeading(section.title), { ...section, index }]));
	let previousIndex = -1;
	for (const heading of required) {
		const actual = actualByName.get(normalizedHeading(heading));
		if (actual === undefined) {
			throw new TicketError(`Ticket '${metadata.id}' is missing required section '${heading}'.`, {
				details: { path, ticket_id: metadata.id, heading },
			});
		}
		if (actual.index <= previousIndex) {
			throw new TicketError(`Ticket '${metadata.id}' required sections are not in canonical contract order.`, {
				details: { path, ticket_id: metadata.id, heading },
			});
		}
		previousIndex = actual.index;
	}
	const firstBodyLine = parseFrontmatter(source, { path }).body.split(/\r?\n/u, 1)[0];
	if (firstBodyLine !== `# ${metadata.title}`) {
		throw new TicketError(`Ticket '${metadata.id}' level-one heading must match its title metadata.`);
	}
	const emptyRequiredSections = [];
	for (const heading of required) {
		if (heading === "Result") continue;
		const content = readLevelTwoSection(source, heading, { includeHeading: false, path });
		if (content.trim().length === 0) emptyRequiredSections.push(heading);
	}
	const resultEmpty = readLevelTwoSection(source, "Result", { includeHeading: false, path }).trim().length === 0;
	const requiresCompleteContract = ["open", "in-progress", "blocked", "completed"].includes(metadata.status);
	if (requiresCompleteContract && emptyRequiredSections.length > 0) {
		throw new TicketError(`Ticket '${metadata.id}' cannot be '${metadata.status}' with empty contract sections.`, {
			details: { ticket_id: metadata.id, empty_sections: emptyRequiredSections },
		});
	}
	if (metadata.status === "completed" && resultEmpty) {
		throw new TicketError(`Completed ticket '${metadata.id}' must retain a non-empty Result section.`);
	}
	return {
		valid: true,
		required_sections: required,
		sections: sections.map(({ title, line }) => ({ title, line })),
		empty_required_sections: emptyRequiredSections,
		result_empty: resultEmpty,
		openable: emptyRequiredSections.length === 0,
	};
}

export function parseTicketArtifact(
	source,
	{ path, expectedId, expectedSlug, expectedWorkflowId } = {},
) {
	const parsed = parseFrontmatter(source, { path });
	const metadata = validateTicketMetadata(parsed.data, {
		path,
		expectedId,
		expectedSlug,
		expectedWorkflowId,
	});
	const contract = validateTicketContract(source, metadata, { path });
	return { ...parsed, data: metadata, contract };
}

export async function listTicketsInContext(context) {
	let entries;
	try {
		const directory = await lstat(context.paths.tickets);
		if (directory.isSymbolicLink() || !directory.isDirectory()) {
			throw new TicketError("Canonical tickets path must be a real directory.", {
				details: { path: context.paths.tickets },
			});
		}
		entries = await readdir(context.paths.tickets, { withFileTypes: true });
	} catch (error) {
		if (error instanceof TicketError) throw error;
		throw new TicketError("Canonical tickets directory cannot be listed safely.", { cause: error });
	}
	const tickets = [];
	const ids = new Set();
	for (const entry of entries) {
		const match = TICKET_FILE_PATTERN.exec(entry.name);
		if (match === null) continue;
		let parsedId;
		try {
			parsedId = parseSequentialId(match[1], { prefix: "T", name: "Ticket ID" });
		} catch (error) {
			throw new TicketError(`Ticket filename '${entry.name}' contains a non-canonical ID.`, { cause: error });
		}
		if (entry.isSymbolicLink() || !entry.isFile()) {
			throw new TicketError("Canonical ticket path must be a real regular file.", {
				details: { path: resolve(context.paths.tickets, entry.name) },
			});
		}
		if (ids.has(match[1])) throw new TicketError(`Ticket ID '${match[1]}' appears more than once.`);
		ids.add(match[1]);
		const path = resolveWithinRoot(context.paths.tickets, entry.name);
		const snapshot = await readFileWithDigest(path, { encoding: "utf8" });
		const parsed = parseTicketArtifact(snapshot.data, {
			path,
			expectedId: match[1],
			expectedSlug: match[2],
			expectedWorkflowId: context.workflow.id,
		});
		tickets.push({
			id: parsed.data.id,
			title: parsed.data.title,
			slug: parsed.data.slug,
			type: parsed.data.type,
			status: parsed.data.status,
			spec_baseline: parsed.data.spec_baseline,
			research_class: parsed.data.research_class,
			depends_on: [...parsed.data.depends_on],
			superseded_by: [...parsed.data.superseded_by],
			execution: {
				...parsed.data.execution,
				conflicts_with: [...parsed.data.execution.conflicts_with],
				claim: parsed.data.execution.claim === null ? null : { ...parsed.data.execution.claim },
			},
			context: extractContextReferences(parsed.data),
			context_budget_exception: parsed.data.context_budget_exception === null
				? null
				: { ...parsed.data.context_budget_exception },
			created_at: parsed.data.created_at,
			updated_at: parsed.data.updated_at,
			path,
			digest: snapshot.digest,
			metadata: parsed.data,
			contract: parsed.contract,
			_number: parsedId.number,
		});
	}
	tickets.sort((left, right) => left._number - right._number);
	return tickets.map(({ _number, ...ticket }) => ticket);
}

export async function listTickets(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return listTicketsInContext(context);
}

export async function inspectTicketInContext(context, ticketId) {
	validateTicketId(ticketId);
	const ticket = (await listTicketsInContext(context)).find(({ id }) => id === ticketId);
	if (ticket === undefined) {
		throw new TicketError(`Ticket '${ticketId}' was not found in workflow '${context.workflow.id}'.`, {
			code: ERROR_CODES.TICKET_NOT_FOUND,
			details: { ticket_id: ticketId, workflow_id: context.workflow.id },
		});
	}
	return ticket;
}

export async function inspectTicket(
	identity,
	workflowId,
	ticketId,
	{ homeDirectory = homedir() } = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return inspectTicketInContext(context, ticketId);
}

export function unresolvedBaselineBlockingTickets(ticketValues) {
	if (!Array.isArray(ticketValues)) throw new ValidationError("ticketValues must be an array.");
	return ticketValues
		.map((ticket) => normalizeTicketMetadata(ticket?.metadata ?? ticket))
		.filter((ticket) => (
			isBaselineBlockingResearch(ticket) &&
			!TERMINAL_TICKET_STATUSES.includes(ticket.status)
		))
		.map(({ id }) => id)
		.sort();
}

function normalizeContextInput(context = {}) {
	if (context === null || typeof context !== "object" || Array.isArray(context)) {
		throw new ValidationError("Ticket context input must be an object.");
	}
	return {
		spec_sections: context.spec_sections ?? context.specSections ?? [],
		decisions: context.decisions ?? [],
		tickets: context.tickets ?? [],
		files: context.files ?? [],
	};
}

function normalizeExecutionInput(type, execution = {}) {
	if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
		throw new ValidationError("Ticket execution input must be an object.");
	}
	const defaults = defaultTicketExecution(type);
	return {
		mode: execution.mode ?? defaults.mode,
		parallel_safe: execution.parallel_safe ?? execution.parallelSafe ?? defaults.parallel_safe,
		conflicts_with: execution.conflicts_with ?? execution.conflictsWith ?? [],
		claim: null,
	};
}

function assertCreationPhase(ticket, context, specMetadata) {
	const phase = context.workflow.phase;
	if (["completed", "cancelled"].includes(phase)) {
		throw new TicketError(`Terminal workflow '${context.workflow.id}' cannot allocate tickets.`);
	}
	const allowedPhases = ticketCreationPhases(ticket);
	if (!allowedPhases.includes(phase)) {
		throw new TicketError(`Ticket type '${ticket.type}' with its declared research class cannot be created in workflow phase '${phase}'.`, {
			details: { allowed_phases: allowedPhases },
		});
	}
	if (!isDeliveryTicket(ticket)) return;
	if (
		context.workflow.metadata.current_baseline === null ||
		ticket.spec_baseline !== context.workflow.metadata.current_baseline ||
		specMetadata.status !== "baselined" ||
		specMetadata.current_baseline !== ticket.spec_baseline
	) {
		throw new TicketError("Delivery ticket baseline must match the active baselined spec.", {
			details: {
				ticket_baseline: ticket.spec_baseline,
				workflow_baseline: context.workflow.metadata.current_baseline,
				spec_baseline: specMetadata.current_baseline,
				spec_status: specMetadata.status,
			},
		});
	}
}

async function readSpecInContext(context) {
	const snapshot = await readFileWithDigest(context.paths.spec, { encoding: "utf8" });
	const parsed = parseSpecArtifact(snapshot.data, {
		path: context.paths.spec,
		expectedWorkflowId: context.workflow.id,
	});
	return { ...snapshot, parsed };
}

async function validateDeclaredContext(context, ticket, tickets, spec, decisions) {
	const availableSpecSections = new Set(spec.parsed.sections.map(({ title }) => normalizedHeading(title)));
	for (const section of ticket.context.spec_sections) {
		if (!availableSpecSections.has(normalizedHeading(section))) {
			throw new TicketError(`Ticket '${ticket.id}' references missing spec section '${section}'.`);
		}
	}
	const decisionIds = new Set(decisions.map(({ id }) => id));
	for (const decisionId of ticket.context.decisions) {
		if (!decisionIds.has(decisionId)) throw new TicketError(`Ticket '${ticket.id}' references missing decision '${decisionId}'.`);
	}
	const ticketIds = new Set(tickets.map(({ id }) => id));
	for (const ticketId of ticket.context.tickets) {
		if (!ticketIds.has(ticketId)) throw new TicketError(`Ticket '${ticket.id}' references missing ticket result '${ticketId}'.`);
	}
}

async function contextContents(context, ticket, tickets, spec, decisions) {
	await validateDeclaredContext(context, ticket, tickets, spec, decisions);
	const contents = [];
	for (const heading of ticket.context.spec_sections) {
		contents.push({
			kind: "spec_section",
			id: heading,
			content: readLevelTwoSection(spec.data, heading, { path: context.paths.spec }),
		});
	}
	const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
	for (const decisionId of ticket.context.decisions) {
		const decision = decisionsById.get(decisionId);
		contents.push({
			kind: "decision",
			id: decisionId,
			content: (await readFileWithDigest(decision.path, { encoding: "utf8" })).data,
		});
	}
	const ticketsById = new Map(tickets.map((candidate) => [candidate.id, candidate]));
	for (const ticketId of ticket.context.tickets) {
		const referenced = ticketsById.get(ticketId);
		const source = (await readFileWithDigest(referenced.path, { encoding: "utf8" })).data;
		contents.push({
			kind: "ticket_result",
			id: ticketId,
			content: readLevelTwoSection(source, "Result", { path: referenced.path }),
		});
	}
	return contents;
}

async function evaluateTicketContext(context, ticket, source, tickets, spec, decisions, contextWindowTokens) {
	const referencedContents = await contextContents(context, ticket, tickets, spec, decisions);
	return evaluateContextBudget({
		ticketSource: source,
		referencedContents,
		contextWindowTokens,
		contextBudgetException: ticket.context_budget_exception,
	});
}

function workflowCounterReplacement(context, number, timestamp, source) {
	const replacement = patchFrontmatter(
		source,
		[
			{ path: ["next_ticket_number"], value: number + 1 },
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
	return replacement;
}

async function assertTicketPathAbsent(path) {
	try {
		const entry = await lstat(path);
		throw new TicketError("Ticket destination already exists and will not be overwritten.", {
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

async function removeOwnedTicket(path, digest) {
	try {
		const snapshot = await readFileWithDigest(path);
		if (snapshot.digest !== digest) return false;
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

export async function createTicket(
	identity,
	workflowId,
	input,
	{
		expectedWorkflowDigest,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
		contextWindowTokens,
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new ValidationError("Ticket input must be an object.");
	}
	if (!TICKET_TYPES.includes(input.type)) {
		throw new ValidationError(`Ticket type must be one of: ${TICKET_TYPES.join(", ")}.`);
	}
	const title = normalizeTitle(input.title);
	const timestamp = canonicalTimestamp(clock);
	const initialStatus = input.status ?? "draft";
	if (initialStatus !== "draft" && initialStatus !== "open") {
		throw new ValidationError("A new ticket status must be 'draft' or 'open'.");
	}
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) {
			throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`, {
				details: { expected_digest: workflowDigest, actual_digest: context.workflow.digest },
			});
		}
		const existingTickets = await listTicketsInContext(context);
		if (input.type === "implementation") {
			const blockers = unresolvedBaselineBlockingTickets(existingTickets);
			if (blockers.length > 0) {
				throw new TicketError("Implementation-ticket creation is blocked by unresolved baseline-blocking research.", {
					details: { ticket_ids: blockers },
				});
			}
		}
		const number = context.workflow.metadata.next_ticket_number;
		if (number >= Number.MAX_SAFE_INTEGER) throw new TicketError("Ticket ID counter is exhausted.");
		const existingNumbers = existingTickets.map(({ id }) => parseSequentialId(id, { prefix: "T" }).number);
		if (existingNumbers.some((existing) => existing >= number)) {
			throw new TicketError("Workflow next_ticket_number is not ahead of all allocated ticket IDs.");
		}
		const id = formatSequentialId("T", number);
		const slug = generateImmutableSlug(title, { fallback: "ticket" });
		const researchClass = input.type === "research"
			? (input.researchClass ?? input.research_class ?? (context.workflow.phase === "discovery" ? "baseline-blocking" : "delivery"))
			: null;
		const delivery = input.type !== "research"
			? ["implementation", "documentation", "review", "verification"].includes(input.type)
			: researchClass === "delivery";
		const metadata = validateTicketMetadata({
			artifact: "ticket",
			schema_version: 1,
			id,
			workflow_id: workflowId,
			title,
			slug,
			type: input.type,
			status: initialStatus,
			spec_baseline: input.specBaseline ?? input.spec_baseline ?? (delivery ? context.workflow.metadata.current_baseline : null),
			research_class: researchClass,
			depends_on: input.dependsOn ?? input.depends_on ?? [],
			superseded_by: [],
			execution: normalizeExecutionInput(input.type, input.execution),
			context: normalizeContextInput(input.context),
			context_budget_exception: input.contextBudgetException ?? input.context_budget_exception ?? null,
			created_at: timestamp,
			updated_at: timestamp,
		}, { expectedId: id, expectedSlug: slug, expectedWorkflowId: workflowId });
		const spec = await readSpecInContext(context);
		assertCreationPhase(metadata, context, spec.parsed.data);
		const path = resolveWithinRoot(context.paths.tickets, ticketFilename(id, slug));
		await assertTicketPathAbsent(path);
		const source = createTicketArtifactSource(metadata, { sections: input.sections });
		const parsed = parseTicketArtifact(source, {
			path,
			expectedId: id,
			expectedSlug: slug,
			expectedWorkflowId: workflowId,
		});
		const candidate = {
			...metadata,
			metadata,
			path,
		};
		const dagTickets = [...existingTickets, candidate];
		validateTicketDag(dagTickets, { workflowId });
		const decisions = await listDecisions(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		await validateDeclaredContext(context, metadata, existingTickets, spec, decisions);
		let contextBudget = await evaluateTicketContext(
			context,
			metadata,
			source,
			existingTickets,
			spec,
			decisions,
			contextWindowTokens,
		);
		if (initialStatus === "open") {
			contextBudget = assertContextBudget({
				ticketSource: source,
				referencedContents: await contextContents(context, metadata, existingTickets, spec, decisions),
				contextWindowTokens,
				contextBudgetException: metadata.context_budget_exception,
			});
		}
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const nextWorkflowSource = workflowCounterReplacement(context, number, timestamp, workflowSource);
		let createdDigest = null;
		let workflowCommitted = false;
		try {
			try {
				const written = await atomicWriteFile(path, source, {
					expectedDigest: null,
					mode: canonicalArtifactFileMode(context.storage),
					root: context.storage.effectivePath,
				});
				createdDigest = written.digest;
			} catch (error) {
				if (error?.details?.committed === true) createdDigest = sha256Hex(source);
				throw error;
			}
			try {
				await atomicWriteFile(context.workflow.path, nextWorkflowSource, {
					expectedDigest: context.workflow.digest,
					root: context.storage.effectivePath,
				});
			} catch (error) {
				workflowCommitted = error?.details?.committed === true;
				throw error;
			}
		} catch (error) {
			if (workflowCommitted) {
				throw new TicketError(
					"Ticket allocation committed, but the workflow directory could not be synchronized; inspect the committed artifacts before retrying.",
					{
						details: { committed: true, ticket_path: path, workflow_path: context.workflow.path },
						cause: error,
					},
				);
			}
			const removed = createdDigest === null ? true : await removeOwnedTicket(path, createdDigest);
			if (!removed) {
				throw new TicketError("Ticket allocation failed and its owned ticket file could not be removed safely.", {
					details: { ticket_path: path },
					cause: error,
				});
			}
			throw error;
		}
		const refreshed = await resolveWorkflowArtifactContext(context.identity, workflowId, {
			homeDirectory: context.homeDirectory,
		});
		return {
			changed: true,
			ticket: await inspectTicketInContext(refreshed, id),
			workflow: refreshed.workflow,
			context_budget: contextBudget,
			contract: parsed.contract,
		};
	}, { homeDirectory, lockOptions });
}

function transitionNeedsRationale(fromStatus, toStatus) {
	return (
		["blocked", "cancelled", "superseded"].includes(toStatus) ||
		(fromStatus === "in-progress" && toStatus === "open") ||
		(fromStatus === "blocked" && toStatus === "open")
	);
}

function normalizeSuccessors(value, ticketId, tickets) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ValidationError("A superseded ticket transition requires at least one successor ticket ID.");
	}
	const available = new Set(tickets.map(({ id }) => id));
	const seen = new Set();
	for (const id of value) {
		validateTicketId(id);
		if (id === ticketId) throw new ValidationError("A superseded ticket must not reference itself as a successor.");
		if (!available.has(id)) throw new ValidationError(`Superseding ticket '${id}' does not exist in the workflow.`);
		if (seen.has(id)) throw new ValidationError(`Superseding ticket '${id}' is duplicated.`);
		seen.add(id);
	}
	return [...value];
}

export async function transitionTicketStatus(
	identity,
	workflowId,
	ticketId,
	toStatus,
	{
		expectedTicketDigest,
		rationale,
		supersededBy,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
		contextWindowTokens,
		externalBlocks = [],
	} = {},
) {
	validateTicketId(ticketId);
	const digest = requireArtifactDigest(expectedTicketDigest, "expectedTicketDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		const tickets = await listTicketsInContext(context);
		const ticket = tickets.find(({ id }) => id === ticketId);
		if (ticket === undefined) {
			throw new TicketError(`Ticket '${ticketId}' was not found in workflow '${workflowId}'.`, {
				code: ERROR_CODES.TICKET_NOT_FOUND,
			});
		}
		if (ticket.digest !== digest) {
			throw new RevisionConflictError(`Ticket '${ticketId}' does not match the expected revision.`, {
				details: { expected_digest: digest, actual_digest: ticket.digest },
			});
		}
		let transition;
		try {
			transition = assertTicketStatusTransition(ticket.status, toStatus);
		} catch (error) {
			throw new TicketError(error.message, {
				code: ERROR_CODES.INVALID_TICKET_TRANSITION,
				details: error.details,
				cause: error,
			});
		}
		if (!transition.changed) return { changed: false, ticket };
		const reason = transitionNeedsRationale(ticket.status, toStatus)
			? normalizeRationale(rationale)
			: null;
		if (toStatus !== "superseded" && supersededBy !== undefined) {
			throw new ValidationError("supersededBy is valid only when transitioning to 'superseded'.");
		}
		const successors = toStatus === "superseded"
			? normalizeSuccessors(supersededBy, ticketId, tickets)
			: [];
		if (toStatus === "open" && ticket.type === "implementation") {
			const blockers = unresolvedBaselineBlockingTickets(tickets.filter(({ id }) => id !== ticketId));
			if (blockers.length > 0) {
				throw new TicketError("Implementation ticket cannot become open while baseline-blocking research is unresolved.", {
					details: { ticket_ids: blockers },
				});
			}
		}
		const source = (await readFileWithDigest(ticket.path, { encoding: "utf8" })).data;
		const patches = [
			{ path: ["status"], value: toStatus },
			{ path: ["superseded_by"], value: successors },
			{ path: ["updated_at"], value: timestamp },
		];
		if (reason === null) patches.push({ path: ["status_reason"], operation: "delete" });
		else {
			patches.push({
				path: ["status_reason"],
				value: { rationale: reason, recorded_at: timestamp },
			});
		}
		const replacement = patchFrontmatter(source, patches, { path: ticket.path });
		const parsed = parseTicketArtifact(replacement, {
			path: ticket.path,
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: workflowId,
		});
		const replacementTicket = { ...ticket, status: toStatus, metadata: parsed.data };
		const replacementTickets = tickets.map((candidate) => candidate.id === ticketId ? replacementTicket : candidate);
		validateTicketDag(replacementTickets, { workflowId });
		const spec = await readSpecInContext(context);
		if (toStatus === "open") {
			assertCreationPhase(parsed.data, context, spec.parsed.data);
			const staleness = deriveTicketStaleness(parsed.data, {
				currentBaseline: spec.parsed.data.current_baseline,
				specStatus: spec.parsed.data.status,
				tickets: replacementTickets.map(({ metadata }) => metadata),
			});
			if (staleness.stale) {
				throw new TicketError(`Ticket '${ticketId}' cannot become open while its declared inputs are stale.`, {
					details: { reasons: staleness.reasons },
				});
			}
		}
		const decisions = await listDecisions(context.identity, workflowId, { homeDirectory: context.homeDirectory });
		const referencedTickets = replacementTickets.filter(({ id }) => id !== ticketId);
		await validateDeclaredContext(context, parsed.data, referencedTickets, spec, decisions);
		const referencedContents = await contextContents(context, parsed.data, referencedTickets, spec, decisions);
		const contextBudget = ["open", "in-progress"].includes(toStatus)
			? assertContextBudget({
				ticketSource: replacement,
				referencedContents,
				contextWindowTokens,
				contextBudgetException: parsed.data.context_budget_exception,
			})
			: evaluateContextBudget({
				ticketSource: replacement,
				referencedContents,
				contextWindowTokens,
				contextBudgetException: parsed.data.context_budget_exception,
			});
		if (toStatus === "in-progress") {
			const readiness = calculateActionableTickets(tickets, {
				workflowPhase: context.workflow.phase,
				currentBaseline: spec.parsed.data.current_baseline,
				specStatus: spec.parsed.data.status,
				decisions,
				externalBlocks,
				contextEvaluations: new Map([[ticketId, contextBudget]]),
			});
			const currentReadiness = readiness.tickets.find(({ id }) => id === ticketId);
			if (!currentReadiness.actionable) {
				throw new TicketError(`Ticket '${ticketId}' cannot become in-progress because it is not actionable.`, {
					details: { reasons: currentReadiness.reasons },
				});
			}
		}
		await atomicWriteFile(ticket.path, replacement, {
			expectedDigest: ticket.digest,
			root: context.storage.effectivePath,
		});
		return {
			changed: true,
			ticket: await inspectTicketInContext(context, ticketId),
			context_budget: contextBudget,
		};
	}, { homeDirectory, lockOptions });
}

export async function queryTicketReadinessInContext(
	context,
	{
		contextWindowTokens,
		externalBlocks = [],
	} = {},
) {
	const tickets = await listTicketsInContext(context);
	validateTicketDag(tickets, { workflowId: context.workflow.id });
	const spec = await readSpecInContext(context);
	const decisions = await listDecisions(context.identity, context.workflow.id, {
		homeDirectory: context.homeDirectory,
	});
	const evaluations = new Map();
	for (const ticket of tickets) {
		const source = (await readFileWithDigest(ticket.path, { encoding: "utf8" })).data;
		evaluations.set(ticket.id, await evaluateTicketContext(
			context,
			ticket.metadata,
			source,
			tickets.filter(({ id }) => id !== ticket.id),
			spec,
			decisions,
			contextWindowTokens,
		));
	}
	return {
		...calculateActionableTickets(tickets, {
			workflowPhase: context.workflow.phase,
			currentBaseline: spec.parsed.data.current_baseline,
			specStatus: spec.parsed.data.status,
			decisions,
			externalBlocks,
			contextEvaluations: evaluations,
		}),
		context_budgets: Object.fromEntries(evaluations),
	};
}

export async function queryTicketReadiness(
	identity,
	workflowId,
	{
		homeDirectory = homedir(),
		contextWindowTokens,
		externalBlocks = [],
	} = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return queryTicketReadinessInContext(context, { contextWindowTokens, externalBlocks });
}
