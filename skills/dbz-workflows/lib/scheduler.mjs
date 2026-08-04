import { homedir } from "node:os";
import { resolveWorkflowArtifactContext } from "./artifacts.mjs";
import { calculateActionableTickets, validateTicketDag } from "./dag.mjs";
import {
	SchedulerError,
	ValidationError,
} from "./errors.mjs";
import { parseSequentialId, validateTicketId } from "./schemas/identifiers.mjs";
import {
	isProjectMutatingTicket,
	normalizeTicketMetadata,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";
import {
	listTicketsInContext,
	queryTicketReadinessInContext,
} from "./tickets.mjs";

export const DEFAULT_MAX_CONCURRENCY = 4;
export const SCHEDULER_EXECUTORS = Object.freeze(["manual", "delegated"]);
const EXCLUSIVE_TICKET_TYPES = Object.freeze(["question-session", "synthesis", "verification"]);

function metadataFrom(value) {
	return validateTicketMetadata(normalizeTicketMetadata(value?.metadata ?? value));
}

function normalizeTickets(values) {
	if (!Array.isArray(values)) throw new ValidationError("tickets must be an array.");
	const tickets = values.map(metadataFrom);
	validateTicketDag(tickets);
	return tickets.sort((left, right) => (
		parseSequentialId(left.id, { prefix: "T" }).number -
		parseSequentialId(right.id, { prefix: "T" }).number
	));
}

function normalizeMaximum(value) {
	const maximum = value ?? DEFAULT_MAX_CONCURRENCY;
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new ValidationError("maxConcurrency must be a positive safe integer.");
	}
	return maximum;
}

function normalizeRequestedIds(value, byId) {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || value.length === 0) {
		throw new SchedulerError("An explicit scheduler selection must contain at least one ticket ID.");
	}
	const seen = new Set();
	for (const id of value) {
		validateTicketId(id);
		if (!byId.has(id)) throw new SchedulerError(`Scheduler selection references missing ticket '${id}'.`);
		if (seen.has(id)) throw new SchedulerError(`Scheduler selection duplicates ticket '${id}'.`);
		seen.add(id);
	}
	return [...value];
}

function normalizeReadiness(tickets, options) {
	if (options.readiness !== undefined) {
		const readiness = options.readiness;
		if (
			readiness === null ||
			typeof readiness !== "object" ||
			!Array.isArray(readiness.tickets) ||
			!Array.isArray(readiness.actionable_ticket_ids)
		) {
			throw new ValidationError("readiness must be a ticket-readiness result.");
		}
		return readiness;
	}
	return calculateActionableTickets(tickets, {
		workflowPhase: options.workflowPhase,
		currentBaseline: options.currentBaseline,
		specStatus: options.specStatus,
		decisions: options.decisions,
		externalBlocks: options.externalBlocks,
		contextEvaluations: options.contextEvaluations,
	});
}

function isExclusive(ticket) {
	return EXCLUSIVE_TICKET_TYPES.includes(ticket.type);
}

function supportsExecutor(ticket, executor) {
	return executor === "manual" || ticket.execution.mode === "delegatable";
}

function declaredConflict(left, right) {
	return (
		left.execution.conflicts_with.includes(right.id) ||
		right.execution.conflicts_with.includes(left.id)
	);
}

function dependencyRelation(left, right) {
	return left.depends_on.includes(right.id) || right.depends_on.includes(left.id);
}

function canShareWave(left, right) {
	return (
		!isExclusive(left) &&
		!isExclusive(right) &&
		left.execution.parallel_safe === true &&
		right.execution.parallel_safe === true &&
		!declaredConflict(left, right) &&
		!dependencyRelation(left, right)
	);
}

function assertValidExplicitWave(tickets, maximum) {
	if (tickets.length > maximum) {
		throw new SchedulerError(`Explicit wave contains ${tickets.length} tickets, exceeding maxConcurrency ${maximum}.`);
	}
	if (tickets.length < 2) return;
	for (const ticket of tickets) {
		if (isExclusive(ticket)) {
			throw new SchedulerError(`Ticket '${ticket.id}' type '${ticket.type}' must execute exclusively.`);
		}
		if (ticket.execution.parallel_safe !== true) {
			const mutating = isProjectMutatingTicket(ticket);
			throw new SchedulerError(
				mutating
					? `Mutating ticket '${ticket.id}' must opt in with execution.parallel_safe: true before parallel scheduling.`
					: `Ticket '${ticket.id}' is not marked parallel-safe.`,
			);
		}
	}
	for (let leftIndex = 0; leftIndex < tickets.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < tickets.length; rightIndex += 1) {
			const left = tickets[leftIndex];
			const right = tickets[rightIndex];
			if (declaredConflict(left, right)) {
				throw new SchedulerError(`Tickets '${left.id}' and '${right.id}' declare an execution conflict.`);
			}
			if (dependencyRelation(left, right)) {
				throw new SchedulerError(`Tickets '${left.id}' and '${right.id}' have a dependency relation and cannot share a wave.`);
			}
		}
	}
}

export function calculateSchedulerWave(ticketValues, options = {}) {
	const tickets = normalizeTickets(ticketValues);
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	const maximum = normalizeMaximum(options.maxConcurrency);
	const executor = options.executor ?? "manual";
	if (!SCHEDULER_EXECUTORS.includes(executor)) {
		throw new ValidationError(`executor must be one of: ${SCHEDULER_EXECUTORS.join(", ")}.`);
	}
	const readiness = normalizeReadiness(tickets, options);
	const actionable = new Set(readiness.actionable_ticket_ids);
	const requested = normalizeRequestedIds(
		options.requestedTicketIds ?? options.requested_ticket_ids,
		byId,
	);
	let selected;
	if (requested !== null) {
		selected = requested.map((id) => {
			if (!actionable.has(id)) {
				const reasons = readiness.tickets.find((candidate) => candidate.id === id)?.reasons ?? [];
				throw new SchedulerError(`Ticket '${id}' is not actionable and cannot enter the requested wave.`, {
					details: { ticket_id: id, reasons },
				});
			}
			const ticket = byId.get(id);
			if (!supportsExecutor(ticket, executor)) {
				throw new SchedulerError(`Ticket '${id}' does not permit delegated execution.`);
			}
			return ticket;
		});
		assertValidExplicitWave(selected, maximum);
	} else {
		const candidates = tickets.filter((ticket) => actionable.has(ticket.id) && supportsExecutor(ticket, executor));
		selected = [];
		for (const candidate of candidates) {
			if (selected.length === 0) {
				selected.push(candidate);
				if (isExclusive(candidate) || candidate.execution.parallel_safe !== true) break;
				continue;
			}
			if (selected.length >= maximum) break;
			if (selected.every((current) => canShareWave(current, candidate))) selected.push(candidate);
		}
	}
	const selectedIds = selected.map(({ id }) => id);
	const selectedSet = new Set(selectedIds);
	return {
		max_concurrency: maximum,
		executor,
		ticket_ids: selectedIds,
		exclusive: selected.length === 1 && isExclusive(selected[0]),
		parallel: selected.length > 1,
		tickets: selected.map((ticket) => ({
			id: ticket.id,
			type: ticket.type,
			execution_mode: ticket.execution.mode,
			parallel_safe: ticket.execution.parallel_safe,
			mutates_project: isProjectMutatingTicket(ticket),
		})),
		deferred_actionable_ticket_ids: readiness.actionable_ticket_ids.filter((id) => !selectedSet.has(id)),
		claims_created: false,
		dispatch_required: true,
	};
}

export async function planSchedulerWave(
	identity,
	workflowId,
	{
		homeDirectory = homedir(),
		contextWindowTokens,
		externalBlocks = [],
		maxConcurrency,
		executor,
		requestedTicketIds,
	} = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	const [tickets, readiness] = await Promise.all([
		listTicketsInContext(context),
		queryTicketReadinessInContext(context, { contextWindowTokens, externalBlocks }),
	]);
	const wave = calculateSchedulerWave(tickets, {
		readiness,
		maxConcurrency,
		executor,
		requestedTicketIds,
	});
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	return {
		workflow_id: workflowId,
		workflow_digest: context.workflow.digest,
		...wave,
		tickets: wave.tickets.map((ticket) => ({
			...ticket,
			digest: byId.get(ticket.id).digest,
		})),
	};
}
