import assert from "node:assert/strict";
import test from "node:test";
import {
	calculateActionableTickets,
	deriveTicketStaleness,
	evaluateDecompositionCoverage,
	validateTicketDag,
} from "./dag.mjs";
import { DagError } from "./errors.mjs";
import { defaultTicketExecution } from "./schemas/ticket.mjs";

const TIMESTAMP = "2026-08-03T15:30:00.000Z";

function ticket(id, type, overrides = {}) {
	const researchClass = type === "research" ? "delivery" : null;
	const delivery = ["implementation", "documentation", "review", "verification"].includes(type) || researchClass === "delivery";
	return {
		artifact: "ticket",
		schema_version: 1,
		id,
		workflow_id: "WF-0001",
		title: `${type} ${id}`,
		slug: `${type}-${id.toLocaleLowerCase("en-US")}`,
		type,
		status: "open",
		spec_baseline: delivery ? "B-0001" : null,
		research_class: researchClass,
		depends_on: [],
		superseded_by: [],
		execution: defaultTicketExecution(type),
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
		context_budget_exception: null,
		created_at: TIMESTAMP,
		updated_at: TIMESTAMP,
		...overrides,
	};
}

test("validates a delivery-research DAG and rejects dependency cycles", () => {
	const research = ticket("T-0001", "research");
	const implementation = ticket("T-0002", "implementation", { depends_on: ["T-0001"] });
	assert.deepEqual(validateTicketDag([research, implementation]).topological_order, ["T-0001", "T-0002"]);
	assert.throws(
		() => validateTicketDag([
			{ ...research, depends_on: ["T-0002"] },
			implementation,
		]),
		DagError,
	);
});

test("only completed dependencies satisfy readiness; cancelled and superseded dependencies require replanning", () => {
	const implementation = ticket("T-0002", "implementation", { depends_on: ["T-0001"] });
	const completed = ticket("T-0001", "research", { status: "completed" });
	let result = calculateActionableTickets([completed, implementation], {
		workflowPhase: "execution",
		currentBaseline: "B-0001",
	});
	assert.deepEqual(result.actionable_ticket_ids, ["T-0002"]);

	const cancelled = { ...completed, status: "cancelled" };
	result = calculateActionableTickets([cancelled, implementation], {
		workflowPhase: "execution",
		currentBaseline: "B-0001",
	});
	assert.equal(result.tickets.find(({ id }) => id === "T-0002").reasons.some(({ code }) => code === "dependency_cancelled"), true);

	const successor = ticket("T-0003", "research");
	const superseded = { ...completed, status: "superseded", superseded_by: ["T-0003"] };
	result = calculateActionableTickets([superseded, implementation, successor], {
		workflowPhase: "execution",
		currentBaseline: "B-0001",
	});
	const implementationResult = result.tickets.find(({ id }) => id === "T-0002");
	assert.equal(implementationResult.reasons.some(({ code }) => code === "dependency_superseded"), true);
	assert.equal(implementationResult.stale, true);
});

test("actionability derives baseline staleness, phase policy, context budget, and active conflicts", () => {
	const claimed = ticket("T-0001", "research", {
		status: "in-progress",
		execution: {
			...defaultTicketExecution("research"),
			claim: { executor: "manual", session_id: "session-1", claimed_at: TIMESTAMP },
		},
	});
	const implementation = ticket("T-0002", "implementation", {
		execution: {
			...defaultTicketExecution("implementation"),
			conflicts_with: ["T-0001"],
		},
	});
	let result = calculateActionableTickets([claimed, implementation], {
		workflowPhase: "execution",
		currentBaseline: "B-0001",
		contextEvaluations: {
			"T-0001": { ready: true },
			"T-0002": { ready: false, estimated_tokens: 40_000, budget_tokens: 32_000 },
		},
	});
	const reasons = result.tickets.find(({ id }) => id === "T-0002").reasons.map(({ code }) => code);
	assert.ok(reasons.includes("conflicting_claim"));
	assert.ok(reasons.includes("context_budget_exceeded"));

	result = calculateActionableTickets([ticket("T-0002", "implementation")], {
		workflowPhase: "planning",
		currentBaseline: "B-0001",
	});
	assert.equal(result.actionable_ticket_ids.length, 0);
	assert.equal(result.tickets[0].reasons.some(({ code }) => code === "type_not_allowed_in_phase"), true);

	const stale = deriveTicketStaleness(
		ticket("T-0002", "implementation", {
			spec_baseline: "B-0002",
			context: { spec_sections: [], decisions: ["D-0001"], tickets: [], files: [] },
		}),
		{
			currentBaseline: "B-0001",
			decisions: [{ id: "D-0001", status: "superseded" }],
		},
	);
	assert.equal(stale.stale, true);
	assert.deepEqual(stale.reasons.map(({ code }) => code), ["baseline_mismatch", "superseded_decision_input"]);
});

test("decomposition coverage reports missing delivery and assurance contracts without making semantic decisions", () => {
	const implementation = ticket("T-0001", "implementation");
	const verification = ticket("T-0002", "verification");
	let coverage = evaluateDecompositionCoverage({
		requiredItems: ["AC-auth", "AC-audit"],
		tickets: [implementation, verification],
		coverageClaims: [
			{ ticket_id: "T-0001", items: ["AC-auth", "AC-audit"] },
			{ ticket_id: "T-0002", items: ["AC-auth"] },
		],
	});
	assert.equal(coverage.complete, false);
	assert.deepEqual(coverage.uncovered_items, ["AC-audit"]);
	assert.deepEqual(coverage.coverage[1].missing_roles, ["assurance"]);

	coverage = evaluateDecompositionCoverage({
		requiredItems: ["AC-auth"],
		tickets: [implementation, verification],
		coverageClaims: [
			{ ticket_id: "T-0001", items: ["AC-auth"] },
			{ ticket_id: "T-0002", items: ["AC-auth"] },
		],
	});
	assert.equal(coverage.complete, true);
});
