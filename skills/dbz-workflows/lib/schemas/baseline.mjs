import {
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import { validateWorkflowId } from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import { isSequentialId } from "./identifiers.mjs";

export const BASELINE_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function baselineMetadataIssues(metadata, { expectedId, expectedWorkflowId } = {}) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Baseline metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "baseline") add(["artifact"], "invalid_artifact", "Baseline artifact must be 'baseline'.");
	if (metadata.schema_version !== BASELINE_SCHEMA_VERSION) {
		add(["schema_version"], "unsupported_schema_version", `Baseline schema_version must be ${BASELINE_SCHEMA_VERSION}.`);
	}
	if (!isSequentialId(metadata.id, "B")) {
		add(["id"], "invalid_baseline_id", "Baseline id must be a canonical baseline ID.");
	}
	if (expectedId !== undefined && metadata.id !== expectedId) {
		add(["id"], "path_identity_mismatch", "Baseline id does not match its canonical filename.", {
			expected_id: expectedId,
			actual_id: metadata.id,
		});
	}
	try {
		validateWorkflowId(metadata.workflow_id);
	} catch {
		add(["workflow_id"], "invalid_workflow_id", "Baseline workflow_id must be a canonical workflow ID.");
	}
	if (expectedWorkflowId !== undefined && metadata.workflow_id !== expectedWorkflowId) {
		add(["workflow_id"], "workflow_identity_mismatch", "Baseline does not belong to the expected workflow.");
	}
	if (metadata.source_synthesis_ticket !== null && !isSequentialId(metadata.source_synthesis_ticket, "T")) {
		add(
			["source_synthesis_ticket"],
			"invalid_ticket_id",
			"Baseline source_synthesis_ticket must be null or a canonical ticket ID.",
		);
	}
	if (typeof metadata.body_sha256 !== "string" || !SHA256_PATTERN.test(metadata.body_sha256)) {
		add(["body_sha256"], "invalid_digest", "Baseline body_sha256 must be a lowercase SHA-256 digest.");
	}
	if (!isRfc3339UtcTimestamp(metadata.approved_at)) {
		add(["approved_at"], "invalid_timestamp", "Baseline approved_at must be an RFC 3339 UTC timestamp.");
	}
	if (metadata.approved_by !== "user") {
		add(["approved_by"], "invalid_approver", "V1 baselines must record approved_by as 'user'.");
	}
	return issues;
}

export function validateBaselineMetadata(metadata, options = {}) {
	throwIfValidationIssues(baselineMetadataIssues(metadata, options), {
		artifact: "baseline",
		path: options.path,
	});
	return metadata;
}
