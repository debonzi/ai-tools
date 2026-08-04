import assert from "node:assert/strict";
import test from "node:test";
import {
	calculateInitialContextBudget,
	evaluateContextBudget,
	extractContextReferences,
} from "./context-budget.mjs";
import { ContextBudgetError } from "./errors.mjs";
import { assertContextBudget } from "./context-budget.mjs";
import { defaultTicketExecution } from "./schemas/ticket.mjs";

const TIMESTAMP = "2026-08-03T15:30:00.000Z";

function ticketMetadata(overrides = {}) {
	return {
		artifact: "ticket",
		schema_version: 1,
		id: "T-0001",
		workflow_id: "WF-0001",
		title: "Implement bounded context",
		slug: "implement-bounded-context",
		type: "implementation",
		status: "open",
		spec_baseline: "B-0001",
		research_class: null,
		depends_on: [],
		superseded_by: [],
		execution: defaultTicketExecution("implementation"),
		context: {
			spec_sections: ["Requirements"],
			decisions: ["D-0001"],
			tickets: ["T-0002"],
			files: ["src/context.mjs"],
		},
		context_budget_exception: null,
		created_at: TIMESTAMP,
		updated_at: TIMESTAMP,
		...overrides,
	};
}

test("calculates the specified 25 percent context budget with a 32,000-token cap", () => {
	assert.deepEqual(calculateInitialContextBudget(80_000), {
		context_window_tokens: 80_000,
		budget_tokens: 20_000,
		source: "active_model",
	});
	assert.equal(calculateInitialContextBudget(200_000).budget_tokens, 32_000);
	assert.deepEqual(calculateInitialContextBudget(), {
		context_window_tokens: 64_000,
		budget_tokens: 16_000,
		source: "conservative_fallback",
	});
});

test("estimates only the ticket and explicit artifact inputs while deferring repository files", () => {
	assert.deepEqual(extractContextReferences(ticketMetadata()), {
		spec_sections: ["Requirements"],
		decisions: ["D-0001"],
		tickets: ["T-0002"],
		files: ["src/context.mjs"],
		repository_files_deferred: true,
	});
	const evaluation = evaluateContextBudget({
		ticketSource: "ticket",
		referencedContents: [
			{ kind: "spec_section", id: "Requirements", content: "requirements" },
			{ kind: "ticket_result", id: "T-0002", content: "result" },
		],
		contextWindowTokens: 8_000,
	});
	assert.deepEqual(evaluation.segments.map(({ kind, id }) => ({ kind, id })), [
		{ kind: "ticket", id: "ticket" },
		{ kind: "spec_section", id: "Requirements" },
		{ kind: "ticket_result", id: "T-0002" },
	]);
	assert.equal(evaluation.segments.some(({ id }) => id === "src/context.mjs"), false);
	assert.equal(evaluation.ready, true);
});

test("rejects over-budget context unless an explicit user-approved exception records justification", () => {
	const input = {
		ticketSource: "x".repeat(1_100),
		referencedContents: [{ kind: "decision", id: "D-0001", content: "y".repeat(200) }],
		contextWindowTokens: 4_000,
	};
	const over = evaluateContextBudget(input);
	assert.equal(over.budget_tokens, 1_000);
	assert.equal(over.within_budget, false);
	assert.equal(over.ready, false);
	assert.throws(() => assertContextBudget(input), ContextBudgetError);

	const excepted = evaluateContextBudget({
		...input,
		contextBudgetException: {
			justification: "The atomic migration contract cannot be split safely.",
			approved_by: "user",
			approved_at: TIMESTAMP,
		},
	});
	assert.equal(excepted.within_budget, false);
	assert.equal(excepted.exception_applied, true);
	assert.equal(excepted.ready, true);
});
