import {
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import { validateWorkflowId } from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import { isSequentialId } from "./identifiers.mjs";

export const VERIFICATION_SCHEMA_VERSION = 1;
export const VERIFICATION_OUTCOMES = Object.freeze(["pending", "passed", "failed", "blocked"]);
export const VERIFICATION_INTEGRATION_STATUSES = Object.freeze([
	"not-required",
	"pending",
	"awaiting",
	"integrated",
	"completed",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSingleLine(value) {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value);
}

function addIntegrationIssues(issues, integration, projectChanges) {
	const add = (path, code, message) => issues.push(validationIssue(["integration", ...path], code, message));
	if (!isPlainObject(integration)) {
		add([], "invalid_integration", "Verification integration metadata must be a mapping.");
		return;
	}
	if (typeof integration.required !== "boolean") {
		add(["required"], "invalid_integration_requirement", "Verification integration.required must be a boolean.");
	}
	if (!VERIFICATION_INTEGRATION_STATUSES.includes(integration.status)) {
		add(["status"], "invalid_integration_status", `Verification integration.status must be one of: ${VERIFICATION_INTEGRATION_STATUSES.join(", ")}.`);
	}
	if (projectChanges === true && integration.required !== true) {
		add(["required"], "integration_requirement_mismatch", "Project-changing verification must require final integration.");
	}
	if (projectChanges === false && (integration.required !== false || integration.status !== "not-required")) {
		add([], "integration_requirement_mismatch", "No-change verification must record integration as not-required.");
	}
	const hasTarget = ["integrated", "completed"].includes(integration.status);
	if (hasTarget) {
		if (!isSingleLine(integration.target_branch)) {
			add(["target_branch"], "invalid_target_branch", "Integrated verification must record a target branch.");
		}
		if (typeof integration.target_commit !== "string" || !OBJECT_ID_PATTERN.test(integration.target_commit)) {
			add(["target_commit"], "invalid_target_commit", "Integrated verification must record a full target commit ID.");
		}
		if (!isRfc3339UtcTimestamp(integration.integrated_at)) {
			add(["integrated_at"], "invalid_timestamp", "Integrated verification must record an RFC 3339 UTC integrated_at timestamp.");
		}
	} else {
		for (const field of ["target_branch", "target_commit", "integrated_at"]) {
			if (integration[field] !== null) add([field], "unexpected_integration_value", `Verification integration.${field} must be null before integration.`);
		}
	}
	if (integration.status === "completed") {
		if (!isRfc3339UtcTimestamp(integration.validated_at)) {
			add(["validated_at"], "invalid_timestamp", "Completed integration must record an RFC 3339 UTC validated_at timestamp.");
		}
		if (!isPlainObject(integration.validation)) {
			add(["validation"], "invalid_post_integration_validation", "Completed integration must record post-integration validation evidence.");
		} else {
			if (!Array.isArray(integration.validation.commands) || integration.validation.commands.length === 0 || integration.validation.commands.some((command) => !isSingleLine(command))) {
				add(["validation", "commands"], "invalid_validation_commands", "Post-integration validation must record at least one single-line command.");
			}
			if (!isSingleLine(integration.validation.evidence)) {
				add(["validation", "evidence"], "invalid_validation_evidence", "Post-integration validation evidence must be a non-empty single-line string.");
			}
		}
	} else {
		if (integration.validated_at !== null) add(["validated_at"], "unexpected_validation_value", "Verification integration.validated_at must be null before completion.");
		if (integration.validation !== null) add(["validation"], "unexpected_validation_value", "Verification integration.validation must be null before completion.");
	}
}

export function verificationMetadataIssues(metadata, { expectedWorkflowId } = {}) {
	const issues = [];
	const add = (path, code, message, details) => issues.push(validationIssue(path, code, message, details));
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Verification metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "verification") add(["artifact"], "invalid_artifact", "Verification artifact must be 'verification'.");
	if (metadata.schema_version !== VERIFICATION_SCHEMA_VERSION) {
		add(["schema_version"], "unsupported_schema_version", `Verification schema_version must be ${VERIFICATION_SCHEMA_VERSION}.`);
	}
	try {
		validateWorkflowId(metadata.workflow_id);
	} catch {
		add(["workflow_id"], "invalid_workflow_id", "Verification workflow_id must be a canonical workflow ID.");
	}
	if (expectedWorkflowId !== undefined && metadata.workflow_id !== expectedWorkflowId) {
		add(["workflow_id"], "workflow_identity_mismatch", "Verification does not belong to the expected workflow.");
	}
	if (!isSequentialId(metadata.baseline, "B")) add(["baseline"], "invalid_baseline_id", "Verification baseline must be a canonical baseline ID.");
	if (metadata.verified_commit !== null && (typeof metadata.verified_commit !== "string" || !OBJECT_ID_PATTERN.test(metadata.verified_commit))) {
		add(["verified_commit"], "invalid_verified_commit", "Verification verified_commit must be null or a full Git object ID.");
	}
	if (!VERIFICATION_OUTCOMES.includes(metadata.outcome)) {
		add(["outcome"], "invalid_outcome", `Verification outcome must be one of: ${VERIFICATION_OUTCOMES.join(", ")}.`);
	}
	if (metadata.outcome === "pending") {
		if (metadata.verified_at !== null) add(["verified_at"], "unexpected_verified_at", "Pending verification must have a null verified_at value.");
	} else if (!isRfc3339UtcTimestamp(metadata.verified_at)) {
		add(["verified_at"], "invalid_timestamp", "A non-pending verification must record an RFC 3339 UTC verified_at timestamp.");
	}
	if (!Number.isSafeInteger(metadata.attempt) || metadata.attempt < 1) add(["attempt"], "invalid_attempt", "Verification attempt must be a positive safe integer.");
	if (typeof metadata.criteria_sha256 !== "string" || !SHA256_PATTERN.test(metadata.criteria_sha256)) {
		add(["criteria_sha256"], "invalid_digest", "Verification criteria_sha256 must be a lowercase SHA-256 digest.");
	}
	if (typeof metadata.project_changes !== "boolean") add(["project_changes"], "invalid_project_changes", "Verification project_changes must be a boolean.");
	if (metadata.project_changes === true && metadata.verified_commit === null) {
		add(["verified_commit"], "missing_verified_commit", "Project-changing verification must record the exact workflow commit.");
	}
	if (metadata.project_changes === false && metadata.verified_commit !== null) {
		add(["verified_commit"], "unexpected_verified_commit", "No-change verification must use a null verified_commit value.");
	}
	if (!Number.isSafeInteger(metadata.blocking_deviations) || metadata.blocking_deviations < 0) {
		add(["blocking_deviations"], "invalid_blocking_deviations", "Verification blocking_deviations must be a non-negative safe integer.");
	}
	if (!Array.isArray(metadata.correction_tickets)) {
		add(["correction_tickets"], "invalid_correction_tickets", "Verification correction_tickets must be an array.");
	} else {
		const seen = new Set();
		for (let index = 0; index < metadata.correction_tickets.length; index += 1) {
			const id = metadata.correction_tickets[index];
			if (!isSequentialId(id, "T")) add(["correction_tickets", index], "invalid_ticket_id", "Correction ticket references must be canonical ticket IDs.");
			else if (seen.has(id)) add(["correction_tickets", index], "duplicate_ticket_id", `Correction ticket '${id}' is duplicated.`);
			seen.add(id);
		}
	}
	addIntegrationIssues(issues, metadata.integration, metadata.project_changes);
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) add([field], "invalid_timestamp", `Verification ${field} must be an RFC 3339 UTC timestamp.`);
	}
	return issues;
}

export function validateVerificationMetadata(metadata, options = {}) {
	throwIfValidationIssues(verificationMetadataIssues(metadata, options), {
		artifact: "verification.md",
		path: options.path,
	});
	return metadata;
}
