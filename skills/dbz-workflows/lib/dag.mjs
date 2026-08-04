import {
	DagError,
	ValidationError,
} from "./errors.mjs";
import { isSequentialId } from "./schemas/identifiers.mjs";
import {
	normalizeTicketMetadata,
	ticketActionablePhases,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";
import { SPEC_STATUSES } from "./schemas/spec.mjs";
import { WORKFLOW_PHASES } from "./schemas/workflow.mjs";

function ticketMetadata(value) {
	const candidate = value?.metadata ?? value;
	return validateTicketMetadata(normalizeTicketMetadata(candidate));
}

function normalizeTickets(tickets) {
	if (!Array.isArray(tickets)) throw new ValidationError("tickets must be an array.");
	const normalized = [];
	const byId = new Map();
	for (const value of tickets) {
		const metadata = ticketMetadata(value);
		if (byId.has(metadata.id)) throw new DagError(`Ticket ID '${metadata.id}' appears more than once in the DAG.`);
		byId.set(metadata.id, metadata);
		normalized.push(metadata);
	}
	return { tickets: normalized, byId };
}

function assertReferencesExist(tickets, byId) {
	for (const ticket of tickets) {
		for (const dependency of ticket.depends_on) {
			if (!byId.has(dependency)) {
				throw new DagError(`Ticket '${ticket.id}' depends on missing ticket '${dependency}'.`, {
					details: { ticket_id: ticket.id, dependency_id: dependency },
				});
			}
		}
		for (const conflict of ticket.execution.conflicts_with) {
			if (!byId.has(conflict)) {
				throw new DagError(`Ticket '${ticket.id}' conflicts with missing ticket '${conflict}'.`, {
					details: { ticket_id: ticket.id, conflict_id: conflict },
				});
			}
		}
		for (const contextTicket of ticket.context.tickets) {
			if (!byId.has(contextTicket)) {
				throw new DagError(`Ticket '${ticket.id}' references missing ticket result '${contextTicket}'.`, {
					details: { ticket_id: ticket.id, context_ticket_id: contextTicket },
				});
			}
		}
	}
}

function topologicalOrder(tickets, byId) {
	const indegree = new Map(tickets.map(({ id, depends_on: dependencies }) => [id, dependencies.length]));
	const dependents = new Map(tickets.map(({ id }) => [id, []]));
	for (const ticket of tickets) {
		for (const dependency of ticket.depends_on) dependents.get(dependency).push(ticket.id);
	}
	const queue = tickets.filter(({ id }) => indegree.get(id) === 0).map(({ id }) => id).sort();
	const order = [];
	while (queue.length > 0) {
		const id = queue.shift();
		order.push(id);
		for (const dependent of dependents.get(id).sort()) {
			const next = indegree.get(dependent) - 1;
			indegree.set(dependent, next);
			if (next === 0) {
				queue.push(dependent);
				queue.sort();
			}
		}
	}
	if (order.length !== tickets.length) {
		const cycleTicketIds = tickets.map(({ id }) => id).filter((id) => !order.includes(id)).sort();
		throw new DagError(`Ticket dependency graph contains a cycle involving: ${cycleTicketIds.join(", ")}.`, {
			details: { ticket_ids: cycleTicketIds },
		});
	}
	return order;
}

export function validateTicketDag(tickets, { workflowId } = {}) {
	const normalized = normalizeTickets(tickets);
	if (workflowId !== undefined) {
		for (const ticket of normalized.tickets) {
			if (ticket.workflow_id !== workflowId) {
				throw new DagError(`Ticket '${ticket.id}' belongs to workflow '${ticket.workflow_id}', not '${workflowId}'.`);
			}
		}
	}
	assertReferencesExist(normalized.tickets, normalized.byId);
	const order = topologicalOrder(normalized.tickets, normalized.byId);
	return {
		valid: true,
		ticket_ids: normalized.tickets.map(({ id }) => id),
		topological_order: order,
		edges: normalized.tickets.flatMap((ticket) => ticket.depends_on.map((dependency) => ({
			from: dependency,
			to: ticket.id,
		}))),
	};
}

function validateCurrentBaseline(currentBaseline) {
	if (currentBaseline !== null && !isSequentialId(currentBaseline, "B")) {
		throw new ValidationError("currentBaseline must be null or a canonical baseline ID.");
	}
}

function normalizeSupersededDecisionIds(decisions) {
	if (!Array.isArray(decisions)) throw new ValidationError("decisions must be an array.");
	const superseded = new Set();
	for (const decision of decisions) {
		const metadata = decision?.metadata ?? decision;
		if (metadata?.status === "superseded" && isSequentialId(metadata.id, "D")) superseded.add(metadata.id);
	}
	return superseded;
}

export function deriveTicketStaleness(
	ticketValue,
	{
		currentBaseline,
		specStatus = "baselined",
		tickets = [],
		decisions = [],
	} = {},
) {
	const ticket = ticketMetadata(ticketValue);
	validateCurrentBaseline(currentBaseline);
	if (!SPEC_STATUSES.includes(specStatus)) throw new ValidationError("specStatus must be a supported spec status.");
	const otherTickets = normalizeTickets(tickets).byId;
	const supersededDecisions = normalizeSupersededDecisionIds(decisions);
	const reasons = [];
	if (ticket.spec_baseline !== null) {
		if (currentBaseline === null) reasons.push({ code: "no_current_baseline" });
		else if (ticket.spec_baseline !== currentBaseline) {
			reasons.push({
				code: "baseline_mismatch",
				expected_baseline: currentBaseline,
				actual_baseline: ticket.spec_baseline,
			});
		} else if (specStatus !== "baselined") {
			reasons.push({ code: specStatus === "suspended" ? "baseline_suspended" : "baseline_under_revision" });
		}
	}
	const referencedTicketIds = new Set([...ticket.depends_on, ...ticket.context.tickets]);
	for (const reference of [...referencedTicketIds].sort()) {
		if (otherTickets.get(reference)?.status === "superseded") {
			reasons.push({ code: "superseded_ticket_input", ticket_id: reference });
		}
	}
	for (const reference of [...ticket.context.decisions].sort()) {
		if (supersededDecisions.has(reference)) reasons.push({ code: "superseded_decision_input", decision_id: reference });
	}
	return {
		ticket_id: ticket.id,
		spec_baseline: ticket.spec_baseline,
		current_baseline: currentBaseline,
		stale: reasons.length > 0,
		reasons,
	};
}

export function isTicketTypeAllowedInPhase(ticketValue, workflowPhase) {
	const ticket = ticketMetadata(ticketValue);
	if (!WORKFLOW_PHASES.includes(workflowPhase)) throw new ValidationError("workflowPhase must be a supported workflow phase.");
	return ticketActionablePhases(ticket).includes(workflowPhase);
}

function normalizeExternalBlocks(value, byId) {
	if (!Array.isArray(value)) throw new ValidationError("externalBlocks must be an array of ticket IDs.");
	const blocks = new Set();
	for (const id of value) {
		if (!isSequentialId(id, "T") || !byId.has(id)) {
			throw new ValidationError(`External block references unknown ticket '${String(id)}'.`);
		}
		blocks.add(id);
	}
	return blocks;
}

function contextEvaluationFor(contextEvaluations, id) {
	if (contextEvaluations === undefined || contextEvaluations === null) return null;
	if (contextEvaluations instanceof Map) return contextEvaluations.get(id) ?? null;
	if (typeof contextEvaluations === "object" && !Array.isArray(contextEvaluations)) return contextEvaluations[id] ?? null;
	throw new ValidationError("contextEvaluations must be a Map or object keyed by ticket ID.");
}

function conflictingClaimIds(ticket, tickets) {
	return tickets
		.filter((candidate) => (
			candidate.execution.claim !== null &&
			(
				ticket.execution.conflicts_with.includes(candidate.id) ||
				candidate.execution.conflicts_with.includes(ticket.id)
			)
		))
		.map(({ id }) => id)
		.sort();
}

export function calculateActionableTickets(
	ticketValues,
	{
		workflowPhase,
		currentBaseline,
		specStatus = "baselined",
		decisions = [],
		externalBlocks = [],
		contextEvaluations,
	} = {},
) {
	if (!WORKFLOW_PHASES.includes(workflowPhase)) throw new ValidationError("workflowPhase must be a supported workflow phase.");
	validateCurrentBaseline(currentBaseline);
	if (!SPEC_STATUSES.includes(specStatus)) throw new ValidationError("specStatus must be a supported spec status.");
	const normalized = normalizeTickets(ticketValues);
	validateTicketDag(normalized.tickets);
	const blocks = normalizeExternalBlocks(externalBlocks, normalized.byId);
	const readiness = normalized.tickets.map((ticket) => {
		const reasons = [];
		if (ticket.status !== "open") reasons.push({ code: "status_not_open", status: ticket.status });
		if (!isTicketTypeAllowedInPhase(ticket, workflowPhase)) {
			reasons.push({ code: "type_not_allowed_in_phase", type: ticket.type, workflow_phase: workflowPhase });
		}
		for (const dependencyId of ticket.depends_on) {
			const dependency = normalized.byId.get(dependencyId);
			if (dependency.status === "cancelled") reasons.push({ code: "dependency_cancelled", ticket_id: dependencyId });
			else if (dependency.status === "superseded") reasons.push({ code: "dependency_superseded", ticket_id: dependencyId });
			else if (dependency.status !== "completed") {
				reasons.push({ code: "dependency_not_completed", ticket_id: dependencyId, status: dependency.status });
			}
		}
		for (const contextTicketId of ticket.context.tickets) {
			const input = normalized.byId.get(contextTicketId);
			if (input !== undefined && input.status !== "completed") {
				reasons.push({ code: "context_ticket_result_unavailable", ticket_id: contextTicketId, status: input.status });
			}
		}
		const staleness = deriveTicketStaleness(ticket, {
			currentBaseline,
			specStatus,
			tickets: normalized.tickets,
			decisions,
		});
		if (staleness.stale) reasons.push({ code: "stale", reasons: staleness.reasons });
		if (blocks.has(ticket.id)) reasons.push({ code: "external_block" });
		const conflicts = conflictingClaimIds(ticket, normalized.tickets);
		if (conflicts.length > 0) reasons.push({ code: "conflicting_claim", ticket_ids: conflicts });
		const contextEvaluation = contextEvaluationFor(contextEvaluations, ticket.id);
		if (contextEvaluation !== null && contextEvaluation.ready !== true) {
			reasons.push({
				code: "context_budget_exceeded",
				estimated_tokens: contextEvaluation.estimated_tokens,
				budget_tokens: contextEvaluation.budget_tokens,
			});
		}
		return {
			id: ticket.id,
			actionable: reasons.length === 0,
			stale: staleness.stale,
			reasons,
		};
	});
	return {
		workflow_phase: workflowPhase,
		current_baseline: currentBaseline,
		actionable_ticket_ids: readiness.filter(({ actionable }) => actionable).map(({ id }) => id),
		tickets: readiness,
	};
}

const COVERAGE_ROLES_BY_TYPE = Object.freeze({
	implementation: "delivery",
	documentation: "delivery",
	review: "assurance",
	verification: "assurance",
});

function normalizeCoverageItems(requiredItems) {
	if (!Array.isArray(requiredItems)) throw new ValidationError("requiredItems must be an array.");
	const seen = new Set();
	return requiredItems.map((item) => {
		if (typeof item !== "string" || item.trim().length === 0 || /[\r\n\0]/u.test(item)) {
			throw new ValidationError("Every decomposition coverage item must be a non-empty single-line identifier.");
		}
		const normalized = item.trim();
		if (seen.has(normalized)) throw new ValidationError(`Decomposition coverage item '${normalized}' is duplicated.`);
		seen.add(normalized);
		return normalized;
	});
}

export function evaluateDecompositionCoverage({
	requiredItems,
	tickets,
	coverageClaims,
	requiredRoles = ["delivery", "assurance"],
}) {
	const items = normalizeCoverageItems(requiredItems);
	const normalized = normalizeTickets(tickets);
	validateTicketDag(normalized.tickets);
	if (!Array.isArray(coverageClaims)) throw new ValidationError("coverageClaims must be an array.");
	if (
		!Array.isArray(requiredRoles) ||
		requiredRoles.length === 0 ||
		requiredRoles.some((role) => role !== "delivery" && role !== "assurance") ||
		new Set(requiredRoles).size !== requiredRoles.length
	) {
		throw new ValidationError("requiredRoles must contain unique 'delivery' and/or 'assurance' values.");
	}
	const itemSet = new Set(items);
	const byItem = new Map(items.map((item) => [item, { delivery: [], assurance: [] }]));
	const seenTickets = new Set();
	for (const claim of coverageClaims) {
		if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
			throw new ValidationError("Every decomposition coverage claim must be an object.");
		}
		if (!isSequentialId(claim.ticket_id, "T") || !normalized.byId.has(claim.ticket_id)) {
			throw new ValidationError(`Coverage claim references unknown ticket '${String(claim.ticket_id)}'.`);
		}
		if (seenTickets.has(claim.ticket_id)) throw new ValidationError(`Ticket '${claim.ticket_id}' has duplicate coverage claims.`);
		seenTickets.add(claim.ticket_id);
		const ticket = normalized.byId.get(claim.ticket_id);
		const role = COVERAGE_ROLES_BY_TYPE[ticket.type];
		if (role === undefined) {
			throw new ValidationError(`Ticket '${ticket.id}' type '${ticket.type}' cannot claim delivery or assurance coverage.`);
		}
		if (!Array.isArray(claim.items) || claim.items.length === 0) {
			throw new ValidationError(`Coverage claim for ticket '${ticket.id}' must identify at least one required item.`);
		}
		const claimed = new Set();
		for (const item of claim.items) {
			if (!itemSet.has(item)) throw new ValidationError(`Ticket '${ticket.id}' claims unknown coverage item '${String(item)}'.`);
			if (claimed.has(item)) throw new ValidationError(`Ticket '${ticket.id}' claims coverage item '${item}' more than once.`);
			claimed.add(item);
			byItem.get(item)[role].push(ticket.id);
		}
	}
	const coverage = items.map((item) => ({
		item,
		delivery_ticket_ids: [...byItem.get(item).delivery].sort(),
		assurance_ticket_ids: [...byItem.get(item).assurance].sort(),
		missing_roles: requiredRoles.filter((role) => byItem.get(item)[role].length === 0),
	}));
	return {
		complete: coverage.every(({ missing_roles: missing }) => missing.length === 0),
		required_roles: [...requiredRoles],
		coverage,
		uncovered_items: coverage.filter(({ missing_roles: missing }) => missing.length > 0).map(({ item }) => item),
	};
}
