import {
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import {
	validateImmutableSlug,
	validateWorkflowId,
} from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import { isSequentialId } from "./identifiers.mjs";

export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_STATUSES = Object.freeze(["accepted", "superseded"]);
export const DECISION_REQUIRED_SECTIONS = Object.freeze([
	"Context",
	"Considered Options",
	"Decision",
	"Rationale",
	"Consequences",
	"Supersession",
]);

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSingleLine(value) {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value);
}

export function decisionMetadataIssues(
	metadata,
	{ expectedId, expectedSlug, expectedWorkflowId } = {},
) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Decision metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "decision") add(["artifact"], "invalid_artifact", "Decision artifact must be 'decision'.");
	if (metadata.schema_version !== DECISION_SCHEMA_VERSION) {
		add(["schema_version"], "unsupported_schema_version", `Decision schema_version must be ${DECISION_SCHEMA_VERSION}.`);
	}
	if (!isSequentialId(metadata.id, "D")) {
		add(["id"], "invalid_decision_id", "Decision id must be a canonical decision ID.");
	}
	if (expectedId !== undefined && metadata.id !== expectedId) {
		add(["id"], "path_identity_mismatch", "Decision id does not match its canonical filename.", {
			expected_id: expectedId,
			actual_id: metadata.id,
		});
	}
	try {
		validateWorkflowId(metadata.workflow_id);
	} catch {
		add(["workflow_id"], "invalid_workflow_id", "Decision workflow_id must be a canonical workflow ID.");
	}
	if (expectedWorkflowId !== undefined && metadata.workflow_id !== expectedWorkflowId) {
		add(["workflow_id"], "workflow_identity_mismatch", "Decision does not belong to the expected workflow.");
	}
	if (!isSingleLine(metadata.title)) {
		add(["title"], "invalid_title", "Decision title must be a non-empty single-line string.");
	}
	try {
		validateImmutableSlug(metadata.slug);
	} catch {
		add(["slug"], "invalid_slug", "Decision slug must be a safe lowercase kebab-case identifier.");
	}
	if (expectedSlug !== undefined && metadata.slug !== expectedSlug) {
		add(["slug"], "path_identity_mismatch", "Decision slug does not match its canonical filename.", {
			expected_slug: expectedSlug,
			actual_slug: metadata.slug,
		});
	}
	if (!DECISION_STATUSES.includes(metadata.status)) {
		add(["status"], "invalid_status", `Decision status must be one of: ${DECISION_STATUSES.join(", ")}.`);
	}
	for (const field of ["supersedes", "superseded_by"]) {
		if (metadata[field] !== null && !isSequentialId(metadata[field], "D")) {
			add([field], "invalid_decision_id", `Decision ${field} must be null or a canonical decision ID.`);
		}
		if (metadata[field] === metadata.id) {
			add([field], "self_reference", `Decision ${field} must not reference itself.`);
		}
	}
	if (metadata.status === "accepted" && metadata.superseded_by !== null) {
		add(["superseded_by"], "status_relation_mismatch", "An accepted decision cannot have superseded_by set.");
	}
	if (metadata.status === "superseded" && metadata.superseded_by === null) {
		add(["superseded_by"], "missing_successor", "A superseded decision must identify its successor.");
	}
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) {
			add([field], "invalid_timestamp", `Decision ${field} must be an RFC 3339 UTC timestamp.`);
		}
	}
	return issues;
}

export function validateDecisionMetadata(metadata, options = {}) {
	throwIfValidationIssues(decisionMetadataIssues(metadata, options), {
		artifact: "decision",
		path: options.path,
	});
	return metadata;
}
