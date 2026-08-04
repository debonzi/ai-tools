import {
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import { validateWorkflowId } from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import {
	isSequentialId,
} from "./identifiers.mjs";

export const SPEC_SCHEMA_VERSION = 1;
export const SPEC_STATUSES = Object.freeze(["draft", "baselined", "suspended"]);

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSingleLine(value) {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value);
}

export function specMetadataIssues(metadata, { expectedWorkflowId } = {}) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Spec metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "spec") add(["artifact"], "invalid_artifact", "Spec artifact must be 'spec'.");
	if (metadata.schema_version !== SPEC_SCHEMA_VERSION) {
		add(["schema_version"], "unsupported_schema_version", `Spec schema_version must be ${SPEC_SCHEMA_VERSION}.`);
	}
	try {
		validateWorkflowId(metadata.workflow_id);
	} catch {
		add(["workflow_id"], "invalid_workflow_id", "Spec workflow_id must be a canonical workflow ID.");
	}
	if (expectedWorkflowId !== undefined && metadata.workflow_id !== expectedWorkflowId) {
		add(["workflow_id"], "workflow_identity_mismatch", "Spec does not belong to the expected workflow.", {
			expected_workflow_id: expectedWorkflowId,
			actual_workflow_id: metadata.workflow_id,
		});
	}
	if (!SPEC_STATUSES.includes(metadata.status)) {
		add(["status"], "invalid_status", `Spec status must be one of: ${SPEC_STATUSES.join(", ")}.`);
	}
	for (const field of ["based_on", "current_baseline"]) {
		if (metadata[field] !== null && !isSequentialId(metadata[field], "B")) {
			add([field], "invalid_baseline_id", `Spec ${field} must be null or a canonical baseline ID.`);
		}
	}
	if (!Array.isArray(metadata.open_blockers)) {
		add(["open_blockers"], "invalid_blockers", "Spec open_blockers must be an array of ticket IDs.");
	} else {
		const seen = new Set();
		for (let index = 0; index < metadata.open_blockers.length; index += 1) {
			const blocker = metadata.open_blockers[index];
			if (!isSequentialId(blocker, "T")) {
				add(["open_blockers", index], "invalid_ticket_id", "Each spec blocker must be a canonical ticket ID.");
			} else if (seen.has(blocker)) {
				add(["open_blockers", index], "duplicate_blocker", `Spec blocker '${blocker}' is duplicated.`);
			}
			seen.add(blocker);
		}
	}
	if (metadata.last_synthesis_ticket !== undefined && metadata.last_synthesis_ticket !== null && !isSequentialId(metadata.last_synthesis_ticket, "T")) {
		add(["last_synthesis_ticket"], "invalid_ticket_id", "Spec last_synthesis_ticket must be null or a canonical ticket ID.");
	}
	if (!isRfc3339UtcTimestamp(metadata.updated_at)) {
		add(["updated_at"], "invalid_timestamp", "Spec updated_at must be an RFC 3339 UTC timestamp.");
	}

	if (metadata.status === "baselined") {
		if (metadata.current_baseline === null) {
			add(["current_baseline"], "missing_current_baseline", "A baselined spec must reference its current baseline.");
		}
		if (Array.isArray(metadata.open_blockers) && metadata.open_blockers.length > 0) {
			add(["open_blockers"], "baselined_with_blockers", "A baselined spec cannot retain open blockers.");
		}
		if (metadata.revision !== undefined && metadata.revision !== null) {
			add(["revision"], "inactive_revision", "A baselined spec must not retain active revision metadata.");
		}
	}
	if (metadata.status === "suspended" && metadata.current_baseline === null) {
		add(["current_baseline"], "missing_current_baseline", "A suspended spec must identify the suspended baseline.");
	}
	if (metadata.based_on !== null && metadata.current_baseline === null) {
		add(["current_baseline"], "inconsistent_baseline", "A spec based on a baseline must also retain a current_baseline reference.");
	}
	if (metadata.status === "suspended" && metadata.based_on !== metadata.current_baseline) {
		add(["based_on"], "inconsistent_baseline", "A suspended spec must be based on its current suspended baseline.");
	}
	if (metadata.revision !== undefined && metadata.revision !== null) {
		if (!isPlainObject(metadata.revision)) {
			add(["revision"], "invalid_revision", "Spec revision metadata must be a mapping.");
		} else {
			if (!isSequentialId(metadata.revision.from_baseline, "B")) {
				add(["revision", "from_baseline"], "invalid_baseline_id", "Spec revision from_baseline must be a baseline ID.");
			}
			if (metadata.revision.from_baseline !== metadata.based_on) {
				add(["revision", "from_baseline"], "inconsistent_baseline", "Spec revision metadata must match based_on.");
			}
			if (!isSingleLine(metadata.revision.rationale)) {
				add(["revision", "rationale"], "invalid_rationale", "Spec revision rationale must be a non-empty single-line string.");
			}
			if (!isRfc3339UtcTimestamp(metadata.revision.started_at)) {
				add(["revision", "started_at"], "invalid_timestamp", "Spec revision started_at must be RFC 3339 UTC.");
			}
		}
		if (metadata.status === "baselined") {
			add(["revision"], "revision_status_mismatch", "Active revision metadata requires draft or suspended status.");
		}
	}
	return issues;
}

export function validateSpecMetadata(metadata, options = {}) {
	throwIfValidationIssues(specMetadataIssues(metadata, options), {
		artifact: "spec.md",
		path: options.path,
	});
	return metadata;
}
