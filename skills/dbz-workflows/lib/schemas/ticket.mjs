import {
	throwIfValidationIssues,
	ValidationError,
	validationIssue,
} from "../errors.mjs";
import {
	validateImmutableSlug,
	validateWorkflowId,
} from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import { isSequentialId } from "./identifiers.mjs";

export const TICKET_SCHEMA_VERSION = 1;
export const TICKET_TYPES = Object.freeze([
	"research",
	"question-session",
	"design",
	"synthesis",
	"implementation",
	"documentation",
	"review",
	"verification",
]);
export const TICKET_STATUSES = Object.freeze([
	"draft",
	"open",
	"in-progress",
	"blocked",
	"completed",
	"cancelled",
	"superseded",
]);
export const TERMINAL_TICKET_STATUSES = Object.freeze(["completed", "cancelled", "superseded"]);
export const RESEARCH_CLASSES = Object.freeze(["baseline-blocking", "delivery"]);
export const TICKET_EXECUTION_MODES = Object.freeze(["manual", "delegatable"]);
export const DISCOVERY_TICKET_TYPES = Object.freeze(["research", "question-session", "design", "synthesis"]);

export const BASE_TICKET_REQUIRED_SECTIONS = Object.freeze([
	"Objective",
	"Context",
	"Scope",
	"Out of Scope",
	"Inputs",
	"Deliverables",
	"Acceptance Criteria",
	"Validation",
	"Result",
]);

const TYPE_SECTION_INSERTIONS = Object.freeze({
	research: Object.freeze({ after: "Objective", sections: Object.freeze(["Research Question", "Sources"]) }),
	"question-session": Object.freeze({ after: "Objective", sections: Object.freeze(["Stakeholder", "Questions"]) }),
	design: Object.freeze({ after: "Inputs", sections: Object.freeze(["Alternatives"]) }),
	synthesis: Object.freeze({ after: "Inputs", sections: Object.freeze(["Discovery Inputs"]) }),
	implementation: Object.freeze({ after: "Inputs", sections: Object.freeze([]) }),
	documentation: Object.freeze({ after: "Inputs", sections: Object.freeze([]) }),
	review: Object.freeze({ after: "Objective", sections: Object.freeze(["Artifact Under Review", "Review Focus"]) }),
	verification: Object.freeze({ after: "Objective", sections: Object.freeze(["Verification Criteria"]) }),
});

export const TICKET_TYPE_POLICIES = Object.freeze({
	research: Object.freeze({
		default_execution: Object.freeze({ mode: "delegatable", parallel_safe: true }),
		allowed_modes: Object.freeze(["manual", "delegatable"]),
	}),
	"question-session": Object.freeze({
		default_execution: Object.freeze({ mode: "manual", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual"]),
	}),
	design: Object.freeze({
		default_execution: Object.freeze({ mode: "delegatable", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual", "delegatable"]),
	}),
	synthesis: Object.freeze({
		default_execution: Object.freeze({ mode: "manual", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual"]),
	}),
	implementation: Object.freeze({
		default_execution: Object.freeze({ mode: "delegatable", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual", "delegatable"]),
	}),
	documentation: Object.freeze({
		default_execution: Object.freeze({ mode: "delegatable", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual", "delegatable"]),
	}),
	review: Object.freeze({
		default_execution: Object.freeze({ mode: "delegatable", parallel_safe: true }),
		allowed_modes: Object.freeze(["manual", "delegatable"]),
	}),
	verification: Object.freeze({
		default_execution: Object.freeze({ mode: "manual", parallel_safe: false }),
		allowed_modes: Object.freeze(["manual"]),
	}),
});

const STATUS_TRANSITIONS = Object.freeze({
	draft: Object.freeze(["open", "cancelled", "superseded"]),
	open: Object.freeze(["in-progress", "blocked", "cancelled", "superseded"]),
	"in-progress": Object.freeze(["open", "blocked", "completed", "cancelled", "superseded"]),
	blocked: Object.freeze(["open", "cancelled", "superseded"]),
	completed: Object.freeze([]),
	cancelled: Object.freeze([]),
	superseded: Object.freeze([]),
});

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSingleLine(value) {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value);
}

function isSafeRelativeFileReference(value) {
	if (
		!isSingleLine(value) ||
		value.startsWith("/") ||
		value.startsWith("\\") ||
		value.includes("\\") ||
		/^[A-Za-z]:\//u.test(value)
	) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function addUniqueIdArrayIssues(issues, value, path, prefix, label, selfId) {
	const add = (issuePath, code, message, details) => {
		issues.push(validationIssue(issuePath, code, message, details));
	};
	if (!Array.isArray(value)) {
		add(path, "invalid_reference_list", `${label} must be an array.`);
		return;
	}
	const seen = new Set();
	for (let index = 0; index < value.length; index += 1) {
		const candidate = value[index];
		if (!isSequentialId(candidate, prefix)) {
			add([...path, index], "invalid_reference", `${label} entries must be canonical ${prefix}- IDs.`);
		} else if (candidate === selfId) {
			add([...path, index], "self_reference", `${label} must not reference the ticket itself.`);
		} else if (seen.has(candidate)) {
			add([...path, index], "duplicate_reference", `${label} contains duplicate '${candidate}'.`);
		}
		seen.add(candidate);
	}
}

function addUniqueStringArrayIssues(issues, value, path, label, validator = isSingleLine) {
	const add = (issuePath, code, message) => issues.push(validationIssue(issuePath, code, message));
	if (!Array.isArray(value)) {
		add(path, "invalid_reference_list", `${label} must be an array.`);
		return;
	}
	const seen = new Set();
	for (let index = 0; index < value.length; index += 1) {
		const candidate = value[index];
		const key = typeof candidate === "string" ? candidate.toLocaleLowerCase("en-US") : candidate;
		if (!validator(candidate)) {
			add([...path, index], "invalid_reference", `${label} contains an invalid reference.`);
		} else if (seen.has(key)) {
			add([...path, index], "duplicate_reference", `${label} contains a duplicate reference.`);
		}
		seen.add(key);
	}
}

export function requiredTicketSections(type) {
	if (!TICKET_TYPES.includes(type)) {
		throw new ValidationError(`Ticket type must be one of: ${TICKET_TYPES.join(", ")}.`);
	}
	const insertion = TYPE_SECTION_INSERTIONS[type];
	if (insertion.sections.length === 0) return [...BASE_TICKET_REQUIRED_SECTIONS];
	const sections = [...BASE_TICKET_REQUIRED_SECTIONS];
	const index = sections.indexOf(insertion.after) + 1;
	sections.splice(index, 0, ...insertion.sections);
	return sections;
}

export function defaultTicketExecution(type) {
	if (!TICKET_TYPES.includes(type)) {
		throw new ValidationError(`Ticket type must be one of: ${TICKET_TYPES.join(", ")}.`);
	}
	const defaults = TICKET_TYPE_POLICIES[type].default_execution;
	return {
		mode: defaults.mode,
		parallel_safe: defaults.parallel_safe,
		conflicts_with: [],
		claim: null,
	};
}

export function isDeliveryTicket(metadata) {
	return (
		metadata?.type === "implementation" ||
		metadata?.type === "documentation" ||
		metadata?.type === "review" ||
		metadata?.type === "verification" ||
		(metadata?.type === "research" && metadata?.research_class === "delivery")
	);
}

export function isBaselineBlockingResearch(metadata) {
	return metadata?.type === "research" && metadata?.research_class === "baseline-blocking";
}

export function isProjectMutatingTicket(metadata) {
	return metadata?.type === "implementation" || metadata?.type === "documentation";
}

export function isDiscoveryTicket(metadata) {
	return DISCOVERY_TICKET_TYPES.includes(metadata?.type) && !isDeliveryTicket(metadata);
}

export function ticketCreationPhases(metadata) {
	return isDiscoveryTicket(metadata)
		? ["discovery"]
		: isDeliveryTicket(metadata)
			? ["planning", "ready", "execution", "verification"]
			: [];
}

export function ticketActionablePhases(metadata) {
	if (isDiscoveryTicket(metadata)) return ["discovery"];
	if (metadata?.type === "verification") return ["verification"];
	if (isDeliveryTicket(metadata)) return ["execution"];
	return [];
}

export function normalizeTicketMetadata(metadata) {
	if (!isPlainObject(metadata)) return metadata;
	const normalized = {
		...metadata,
		...(metadata.spec_baseline === undefined ? { spec_baseline: null } : {}),
		...(metadata.research_class === undefined ? { research_class: null } : {}),
		...(metadata.context_budget_exception === undefined ? { context_budget_exception: null } : {}),
	};
	if (isPlainObject(metadata.execution)) {
		normalized.execution = {
			...metadata.execution,
			...(metadata.execution.claim === undefined ? { claim: null } : {}),
			...(Array.isArray(metadata.execution.conflicts_with)
				? { conflicts_with: [...metadata.execution.conflicts_with] }
				: {}),
		};
	}
	if (isPlainObject(metadata.context)) {
		normalized.context = {
			...metadata.context,
			...(Array.isArray(metadata.context.spec_sections) ? { spec_sections: [...metadata.context.spec_sections] } : {}),
			...(Array.isArray(metadata.context.decisions) ? { decisions: [...metadata.context.decisions] } : {}),
			...(Array.isArray(metadata.context.tickets) ? { tickets: [...metadata.context.tickets] } : {}),
			...(Array.isArray(metadata.context.files) ? { files: [...metadata.context.files] } : {}),
		};
	}
	if (Array.isArray(metadata.depends_on)) normalized.depends_on = [...metadata.depends_on];
	if (Array.isArray(metadata.superseded_by)) normalized.superseded_by = [...metadata.superseded_by];
	return normalized;
}

export function contextBudgetExceptionIssues(value, path = ["context_budget_exception"]) {
	const issues = [];
	const add = (suffix, code, message) => issues.push(validationIssue([...path, ...suffix], code, message));
	if (value === null) return issues;
	if (!isPlainObject(value)) {
		add([], "invalid_budget_exception", "Ticket context_budget_exception must be null or a mapping.");
		return issues;
	}
	if (!isSingleLine(value.justification)) {
		add(["justification"], "invalid_justification", "A context budget exception requires a non-empty single-line justification.");
	}
	if (value.approved_by !== "user") {
		add(["approved_by"], "invalid_approver", "A context budget exception must be explicitly approved_by 'user'.");
	}
	if (!isRfc3339UtcTimestamp(value.approved_at)) {
		add(["approved_at"], "invalid_timestamp", "A context budget exception approved_at value must be RFC 3339 UTC.");
	}
	return issues;
}

export function validateContextBudgetException(value) {
	throwIfValidationIssues(contextBudgetExceptionIssues(value), { artifact: "ticket" });
	return value;
}

export function ticketMetadataIssues(rawMetadata, { expectedId, expectedSlug, expectedWorkflowId } = {}) {
	const metadata = normalizeTicketMetadata(rawMetadata);
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Ticket metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "ticket") add(["artifact"], "invalid_artifact", "Ticket artifact must be 'ticket'.");
	if (metadata.schema_version !== TICKET_SCHEMA_VERSION) {
		add(["schema_version"], "unsupported_schema_version", `Ticket schema_version must be ${TICKET_SCHEMA_VERSION}.`);
	}
	if (!isSequentialId(metadata.id, "T")) {
		add(["id"], "invalid_ticket_id", "Ticket id must be a canonical ticket ID.");
	}
	if (expectedId !== undefined && metadata.id !== expectedId) {
		add(["id"], "path_identity_mismatch", "Ticket id does not match its canonical filename.", {
			expected_id: expectedId,
			actual_id: metadata.id,
		});
	}
	try {
		validateWorkflowId(metadata.workflow_id);
	} catch {
		add(["workflow_id"], "invalid_workflow_id", "Ticket workflow_id must be a canonical workflow ID.");
	}
	if (expectedWorkflowId !== undefined && metadata.workflow_id !== expectedWorkflowId) {
		add(["workflow_id"], "workflow_identity_mismatch", "Ticket does not belong to the expected workflow.");
	}
	if (!isSingleLine(metadata.title)) add(["title"], "invalid_title", "Ticket title must be a non-empty single-line string.");
	try {
		validateImmutableSlug(metadata.slug);
	} catch {
		add(["slug"], "invalid_slug", "Ticket slug must be a safe lowercase kebab-case identifier.");
	}
	if (expectedSlug !== undefined && metadata.slug !== expectedSlug) {
		add(["slug"], "path_identity_mismatch", "Ticket slug does not match its canonical filename.", {
			expected_slug: expectedSlug,
			actual_slug: metadata.slug,
		});
	}
	if (!TICKET_TYPES.includes(metadata.type)) {
		add(["type"], "invalid_type", `Ticket type must be one of: ${TICKET_TYPES.join(", ")}.`);
	}
	if (!TICKET_STATUSES.includes(metadata.status)) {
		add(["status"], "invalid_status", `Ticket status must be one of: ${TICKET_STATUSES.join(", ")}.`);
	}
	if (metadata.status === "ready" || metadata.status === "stale") {
		add(["status"], "derived_state_persisted", "Ticket readiness and staleness are derived and must not be persisted as statuses.");
	}
	if (metadata.spec_baseline !== null && !isSequentialId(metadata.spec_baseline, "B")) {
		add(["spec_baseline"], "invalid_baseline_id", "Ticket spec_baseline must be null or a canonical baseline ID.");
	}
	if (metadata.type === "research") {
		if (!RESEARCH_CLASSES.includes(metadata.research_class)) {
			add(["research_class"], "invalid_research_class", `Research class must be one of: ${RESEARCH_CLASSES.join(", ")}.`);
		}
	} else if (metadata.research_class !== null) {
		add(["research_class"], "field_not_applicable", "research_class is applicable only to research tickets and must otherwise be null or omitted.");
	}
	if (isDeliveryTicket(metadata)) {
		if (!isSequentialId(metadata.spec_baseline, "B")) {
			add(["spec_baseline"], "missing_baseline", "Delivery tickets must reference an approved baseline.");
		}
	} else if (metadata.spec_baseline !== null) {
		add(["spec_baseline"], "discovery_baseline_mismatch", "Baseline-blocking discovery tickets must have a null spec_baseline.");
	}
	addUniqueIdArrayIssues(issues, metadata.depends_on, ["depends_on"], "T", "Ticket depends_on", metadata.id);
	addUniqueIdArrayIssues(issues, metadata.superseded_by, ["superseded_by"], "T", "Ticket superseded_by", metadata.id);
	if (metadata.status === "superseded" && Array.isArray(metadata.superseded_by) && metadata.superseded_by.length === 0) {
		add(["superseded_by"], "missing_successor", "A superseded ticket must identify at least one successor ticket.");
	}
	if (metadata.status !== "superseded" && Array.isArray(metadata.superseded_by) && metadata.superseded_by.length > 0) {
		add(["superseded_by"], "status_relation_mismatch", "Only a superseded ticket may set superseded_by.");
	}
	if (!isPlainObject(metadata.execution)) {
		add(["execution"], "invalid_execution", "Ticket execution metadata must be a mapping.");
	} else {
		if (!TICKET_EXECUTION_MODES.includes(metadata.execution.mode)) {
			add(["execution", "mode"], "invalid_execution_mode", `Ticket execution mode must be one of: ${TICKET_EXECUTION_MODES.join(", ")}.`);
		} else if (TICKET_TYPES.includes(metadata.type) && !TICKET_TYPE_POLICIES[metadata.type].allowed_modes.includes(metadata.execution.mode)) {
			add(["execution", "mode"], "type_execution_mismatch", `Ticket type '${metadata.type}' does not support execution mode '${metadata.execution.mode}'.`);
		}
		if (typeof metadata.execution.parallel_safe !== "boolean") {
			add(["execution", "parallel_safe"], "invalid_parallel_policy", "Ticket execution parallel_safe must be a boolean.");
		}
		if (["question-session", "synthesis", "verification"].includes(metadata.type) && metadata.execution.parallel_safe === true) {
			add(["execution", "parallel_safe"], "exclusive_ticket_parallelism", `Ticket type '${metadata.type}' must not be marked parallel_safe.`);
		}
		addUniqueIdArrayIssues(
			issues,
			metadata.execution.conflicts_with,
			["execution", "conflicts_with"],
			"T",
			"Ticket execution conflicts_with",
			metadata.id,
		);
		const claim = metadata.execution.claim;
		if (claim !== null) {
			if (!isPlainObject(claim)) {
				add(["execution", "claim"], "invalid_claim", "Ticket claim must be null or a mapping.");
			} else {
				if (!isSingleLine(claim.executor)) add(["execution", "claim", "executor"], "invalid_executor", "Ticket claim executor must be a non-empty single-line identifier.");
				if (!isSingleLine(claim.session_id)) add(["execution", "claim", "session_id"], "invalid_session_id", "Ticket claim session_id must be a non-empty single-line identifier.");
				if (claim.claim_id !== undefined && !isSingleLine(claim.claim_id)) add(["execution", "claim", "claim_id"], "invalid_claim_id", "Ticket claim claim_id must be a non-empty single-line identifier when present.");
				if (!isRfc3339UtcTimestamp(claim.claimed_at)) add(["execution", "claim", "claimed_at"], "invalid_timestamp", "Ticket claim claimed_at must be RFC 3339 UTC.");
			}
		}
	}
	if (!isPlainObject(metadata.context)) {
		add(["context"], "invalid_context", "Ticket context metadata must be a mapping.");
	} else {
		addUniqueStringArrayIssues(issues, metadata.context.spec_sections, ["context", "spec_sections"], "Ticket context spec_sections");
		addUniqueIdArrayIssues(issues, metadata.context.decisions, ["context", "decisions"], "D", "Ticket context decisions");
		addUniqueIdArrayIssues(issues, metadata.context.tickets, ["context", "tickets"], "T", "Ticket context tickets", metadata.id);
		addUniqueStringArrayIssues(issues, metadata.context.files, ["context", "files"], "Ticket context files", isSafeRelativeFileReference);
	}
	issues.push(...contextBudgetExceptionIssues(metadata.context_budget_exception));
	if (metadata.status_reason !== undefined && metadata.status_reason !== null) {
		if (!isPlainObject(metadata.status_reason)) {
			add(["status_reason"], "invalid_status_reason", "Ticket status_reason must be a mapping when present.");
		} else {
			if (!isSingleLine(metadata.status_reason.rationale)) add(["status_reason", "rationale"], "invalid_rationale", "Ticket status rationale must be a non-empty single-line string.");
			if (!isRfc3339UtcTimestamp(metadata.status_reason.recorded_at)) add(["status_reason", "recorded_at"], "invalid_timestamp", "Ticket status reason recorded_at must be RFC 3339 UTC.");
		}
	}
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) add([field], "invalid_timestamp", `Ticket ${field} must be an RFC 3339 UTC timestamp.`);
	}
	return issues;
}

export function validateTicketMetadata(metadata, options = {}) {
	const normalized = normalizeTicketMetadata(metadata);
	throwIfValidationIssues(ticketMetadataIssues(normalized, options), {
		artifact: "ticket",
		path: options.path,
	});
	return normalized;
}

export function assertTicketStatusTransition(fromStatus, toStatus) {
	if (!TICKET_STATUSES.includes(fromStatus) || !TICKET_STATUSES.includes(toStatus)) {
		throw new ValidationError("Ticket status transition requires two supported statuses.");
	}
	if (fromStatus === toStatus) return { from: fromStatus, to: toStatus, changed: false };
	if (!STATUS_TRANSITIONS[fromStatus].includes(toStatus)) {
		throw new ValidationError(`Ticket status cannot transition from '${fromStatus}' to '${toStatus}'.`, {
			details: { from_status: fromStatus, to_status: toStatus, allowed: STATUS_TRANSITIONS[fromStatus] },
		});
	}
	return { from: fromStatus, to: toStatus, changed: true };
}

export const TICKET_STATUS_TRANSITIONS = STATUS_TRANSITIONS;
