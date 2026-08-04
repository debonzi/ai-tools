import assert from "node:assert/strict";
import test from "node:test";
import { SchemaValidationError, TicketError } from "./errors.mjs";
import {
	defaultTicketExecution,
	requiredTicketSections,
	TICKET_TYPES,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";
import { createTicketArtifactSource } from "./templates/tickets/index.mjs";
import { parseTicketArtifact } from "./tickets.mjs";

const TIMESTAMP = "2026-08-03T15:30:00.000Z";

function metadata(type, overrides = {}) {
	const delivery = ["implementation", "documentation", "review", "verification"].includes(type);
	const researchClass = type === "research" ? "baseline-blocking" : null;
	return {
		artifact: "ticket",
		schema_version: 1,
		id: "T-0001",
		workflow_id: "WF-0001",
		title: `Validate ${type} contract`,
		slug: `validate-${type}-contract`,
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

function sections(type, { result = "" } = {}) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? result : `${heading} contract content.`,
	]));
}

test("all eight V1 ticket types serialize and validate their exact required contracts", () => {
	assert.equal(TICKET_TYPES.length, 8);
	for (const type of TICKET_TYPES) {
		const ticket = metadata(type);
		const source = createTicketArtifactSource(ticket, { sections: sections(type) });
		const parsed = parseTicketArtifact(source, {
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: ticket.workflow_id,
		});
		assert.equal(parsed.data.type, type);
		assert.deepEqual(parsed.contract.required_sections, requiredTicketSections(type));
		assert.equal(parsed.contract.openable, true);
	}
});

test("ticket validation preserves forward-compatible unknown metadata", () => {
	const ticket = metadata("design", { future_extension: { retained: true } });
	const source = createTicketArtifactSource(ticket, { sections: sections("design") });
	assert.deepEqual(parseTicketArtifact(source).data.future_extension, { retained: true });
});

test("type-specific metadata and sections cannot be bypassed", () => {
	assert.throws(
		() => validateTicketMetadata(metadata("research", { research_class: null })),
		SchemaValidationError,
	);
	assert.throws(
		() => validateTicketMetadata(metadata("question-session", {
			execution: { ...defaultTicketExecution("question-session"), mode: "delegatable" },
		})),
		SchemaValidationError,
	);
	assert.throws(
		() => validateTicketMetadata(metadata("implementation", { spec_baseline: null })),
		SchemaValidationError,
	);
	const normalized = validateTicketMetadata(metadata("design", { research_class: undefined }));
	assert.equal(normalized.research_class, null);

	const source = createTicketArtifactSource(metadata("research"), { sections: sections("research") });
	const withoutQuestion = source.replace(
		"## Research Question\n\nResearch Question contract content.\n\n",
		"",
	);
	assert.throws(() => parseTicketArtifact(withoutQuestion), TicketError);
});

test("drafts may hold empty contract content, but open and completed states enforce content", () => {
	const draft = metadata("design", { status: "draft" });
	const source = createTicketArtifactSource(draft);
	const parsed = parseTicketArtifact(source);
	assert.equal(parsed.contract.openable, false);
	assert.ok(parsed.contract.empty_required_sections.includes("Objective"));

	const invalidOpen = source.replace("status: draft", "status: open");
	assert.throws(() => parseTicketArtifact(invalidOpen), TicketError);
	const completedWithoutResult = createTicketArtifactSource(
		metadata("design", { status: "completed" }),
		{ sections: sections("design") },
	);
	assert.throws(() => parseTicketArtifact(completedWithoutResult), TicketError);
	const completed = createTicketArtifactSource(
		metadata("design", { status: "completed" }),
		{ sections: sections("design", { result: "The design was accepted." }) },
	);
	assert.equal(parseTicketArtifact(completed).data.status, "completed");
});

test("ready and stale remain derived rather than persisted ticket statuses", () => {
	for (const status of ["ready", "stale"]) {
		assert.throws(
			() => validateTicketMetadata(metadata("design", { status })),
			(error) => (
				error instanceof SchemaValidationError &&
				error.issues.some(({ code }) => code === "derived_state_persisted")
			),
		);
	}
});
