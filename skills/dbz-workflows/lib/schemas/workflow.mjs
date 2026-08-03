import {
	SchemaValidationError,
	ValidationError,
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import { validateWorkflowId, validateImmutableSlug, workflowBranchName } from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";
import { validateObjectId } from "../git-identity.mjs";
import { isSequentialId, parseSequentialId } from "./identifiers.mjs";

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_PHASES = Object.freeze([
	"discovery",
	"planning",
	"ready",
	"execution",
	"verification",
	"completed",
	"cancelled",
]);
export const WORKFLOW_CONDITIONS = Object.freeze(["blocked", "awaiting-integration"]);
export const ISSUE_RELATIONS = Object.freeze(["resolves", "partially-addresses", "related"]);

const ISSUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const TRANSITIONS = Object.freeze({
	discovery: Object.freeze(["planning", "cancelled"]),
	planning: Object.freeze(["discovery", "ready", "cancelled"]),
	ready: Object.freeze(["execution", "discovery", "cancelled"]),
	execution: Object.freeze(["discovery", "verification", "cancelled"]),
	verification: Object.freeze(["discovery", "execution", "completed", "cancelled"]),
	completed: Object.freeze([]),
	cancelled: Object.freeze([]),
});

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSingleLine(value) {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value);
}

function isFullObjectId(value, objectFormat) {
	try {
		if (objectFormat === undefined) {
			return (
				(typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)) ||
				(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value))
			);
		}
		validateObjectId(objectFormat, value);
		return true;
	} catch {
		return false;
	}
}

function workflowIssues(metadata, { expectedId, expectedSlug, objectFormat } = {}) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (!isPlainObject(metadata)) {
		add([], "invalid_metadata", "Workflow metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "workflow") {
		add(["artifact"], "invalid_artifact", "Workflow artifact must be 'workflow'.");
	}
	if (metadata.schema_version !== WORKFLOW_SCHEMA_VERSION) {
		add(
			["schema_version"],
			"unsupported_schema_version",
			`Workflow schema_version must be ${WORKFLOW_SCHEMA_VERSION}.`,
		);
	}
	try {
		validateWorkflowId(metadata.id);
	} catch {
		add(["id"], "invalid_workflow_id", "Workflow id must use 'WF-' and a positive zero-padded number.");
	}
	if (expectedId !== undefined && metadata.id !== expectedId) {
		add(["id"], "path_identity_mismatch", "Workflow id does not match its canonical directory.", {
			expected_id: expectedId,
			actual_id: metadata.id,
		});
	}
	if (!isSingleLine(metadata.title)) {
		add(["title"], "invalid_title", "Workflow title must be a non-empty single-line string.");
	}
	try {
		validateImmutableSlug(metadata.slug);
	} catch {
		add(["slug"], "invalid_slug", "Workflow slug must be a safe lowercase kebab-case identifier.");
	}
	if (expectedSlug !== undefined && metadata.slug !== expectedSlug) {
		add(["slug"], "path_identity_mismatch", "Workflow slug does not match its canonical directory.", {
			expected_slug: expectedSlug,
			actual_slug: metadata.slug,
		});
	}
	if (!WORKFLOW_PHASES.includes(metadata.phase)) {
		add(["phase"], "invalid_phase", `Workflow phase must be one of: ${WORKFLOW_PHASES.join(", ")}.`);
	}
	if (!Array.isArray(metadata.conditions)) {
		add(["conditions"], "invalid_conditions", "Workflow conditions must be an array.");
	} else {
		const seen = new Set();
		for (let index = 0; index < metadata.conditions.length; index += 1) {
			const condition = metadata.conditions[index];
			if (!WORKFLOW_CONDITIONS.includes(condition)) {
				add(["conditions", index], "invalid_condition", `Unsupported workflow condition '${String(condition)}'.`);
			} else if (seen.has(condition)) {
				add(["conditions", index], "duplicate_condition", `Workflow condition '${condition}' is duplicated.`);
			}
			seen.add(condition);
		}
		if (metadata.conditions.includes("awaiting-integration") && metadata.phase !== "verification") {
			add(
				["conditions"],
				"condition_phase_mismatch",
				"The 'awaiting-integration' condition is valid only during verification.",
			);
		}
		if (["completed", "cancelled"].includes(metadata.phase) && metadata.conditions.length > 0) {
			add(["conditions"], "terminal_conditions", "Terminal workflows must not retain active conditions.");
		}
	}
	if (metadata.current_baseline !== null && !isSequentialId(metadata.current_baseline, "B")) {
		add(["current_baseline"], "invalid_baseline_id", "Workflow current_baseline must be null or a baseline ID.");
	}
	for (const field of ["next_baseline_number", "next_ticket_number", "next_decision_number"]) {
		if (!Number.isSafeInteger(metadata[field]) || metadata[field] < 1) {
			add([field], "invalid_counter", `Workflow ${field} must be a positive safe integer.`);
		}
	}
	if (isSequentialId(metadata.current_baseline, "B") && Number.isSafeInteger(metadata.next_baseline_number)) {
		const currentNumber = parseSequentialId(metadata.current_baseline, { prefix: "B" }).number;
		if (metadata.next_baseline_number <= currentNumber) {
			add(
				["next_baseline_number"],
				"counter_not_advanced",
				"Workflow next_baseline_number must be greater than current_baseline.",
			);
		}
	}
	if (["planning", "ready", "execution", "verification", "completed"].includes(metadata.phase) && metadata.current_baseline === null) {
		add(["current_baseline"], "missing_current_baseline", `Workflow phase '${metadata.phase}' requires an approved baseline.`);
	}
	if (!Array.isArray(metadata.issues)) {
		add(["issues"], "invalid_issue_links", "Workflow issues must be an array.");
	} else {
		const seen = new Set();
		for (let index = 0; index < metadata.issues.length; index += 1) {
			const link = metadata.issues[index];
			if (!isPlainObject(link)) {
				add(["issues", index], "invalid_issue_link", "Each workflow issue link must be a mapping.");
				continue;
			}
			if (typeof link.id !== "string" || !ISSUE_ID_PATTERN.test(link.id)) {
				add(["issues", index, "id"], "invalid_issue_id", "Issue link id must be a safe identifier.");
			} else if (seen.has(link.id)) {
				add(["issues", index, "id"], "duplicate_issue_link", `Issue '${link.id}' is linked more than once.`);
			}
			seen.add(link.id);
			if (!ISSUE_RELATIONS.includes(link.relation)) {
				add(
					["issues", index, "relation"],
					"invalid_issue_relation",
					`Issue relation must be one of: ${ISSUE_RELATIONS.join(", ")}.`,
				);
			}
		}
	}
	if (!isPlainObject(metadata.git)) {
		add(["git"], "invalid_git_metadata", "Workflow git metadata must be a mapping.");
	} else {
		if (metadata.git.base_branch !== null && !isSingleLine(metadata.git.base_branch)) {
			add(["git", "base_branch"], "invalid_base_branch", "Workflow base_branch must be null or a branch name.");
		}
		if (!isFullObjectId(metadata.git.base_commit, objectFormat)) {
			add(["git", "base_commit"], "invalid_base_commit", "Workflow base_commit must be a full Git object ID.");
		}
		let expectedBranch;
		try {
			expectedBranch = workflowBranchName(metadata.id, metadata.slug);
		} catch {}
		if (expectedBranch !== undefined && metadata.git.workflow_branch !== expectedBranch) {
			add(
				["git", "workflow_branch"],
				"invalid_workflow_branch",
				"Workflow branch must be derived from the immutable workflow id and slug.",
				{ expected_branch: expectedBranch, actual_branch: metadata.git.workflow_branch },
			);
		}
		if (
			metadata.git.integrated_commit !== null &&
			!isFullObjectId(metadata.git.integrated_commit, objectFormat)
		) {
			add(
				["git", "integrated_commit"],
				"invalid_integrated_commit",
				"Workflow integrated_commit must be null or a full Git object ID.",
			);
		}
	}
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) {
			add([field], "invalid_timestamp", `Workflow ${field} must be an RFC 3339 UTC timestamp.`);
		}
	}
	if (metadata.phase === "cancelled" && (metadata.cancellation === undefined || metadata.cancellation === null)) {
		add(["cancellation"], "missing_cancellation", "Cancelled workflows must record cancellation metadata.");
	}
	if (metadata.cancellation !== undefined && metadata.cancellation !== null) {
		if (!isPlainObject(metadata.cancellation)) {
			add(["cancellation"], "invalid_cancellation", "Workflow cancellation metadata must be a mapping.");
		} else {
			if (!isSingleLine(metadata.cancellation.rationale)) {
				add(["cancellation", "rationale"], "invalid_rationale", "Cancellation rationale must be a non-empty single-line string.");
			}
			if (!isRfc3339UtcTimestamp(metadata.cancellation.cancelled_at)) {
				add(["cancellation", "cancelled_at"], "invalid_timestamp", "Cancellation timestamp must be RFC 3339 UTC.");
			}
		}
		if (metadata.phase !== "cancelled") {
			add(["cancellation"], "cancellation_phase_mismatch", "Cancellation metadata is valid only for a cancelled workflow.");
		}
	}
	return issues;
}

export function validateWorkflowMetadata(metadata, options = {}) {
	throwIfValidationIssues(workflowIssues(metadata, options), {
		artifact: "workflow.md",
		path: options.path,
	});
	return metadata;
}

export function normalizeIssueLinks(links) {
	const candidate = {
		artifact: "workflow",
		schema_version: WORKFLOW_SCHEMA_VERSION,
		id: "WF-0001",
		title: "Issue validation",
		slug: "issue-validation",
		phase: "discovery",
		conditions: [],
		current_baseline: null,
		next_baseline_number: 1,
		next_ticket_number: 1,
		next_decision_number: 1,
		issues: links,
		git: {
			base_branch: null,
			base_commit: "0".repeat(40),
			workflow_branch: "dbz-workflows/WF-0001-issue-validation",
			integrated_commit: null,
		},
		created_at: "2000-01-01T00:00:00Z",
		updated_at: "2000-01-01T00:00:00Z",
	};
	const issues = workflowIssues(candidate).filter(({ path }) => path[0] === "issues");
	if (issues.length > 0) {
		throw new SchemaValidationError(`Issue links failed schema validation with ${issues.length} issue(s).`, {
			issues,
			details: { artifact: "workflow.md" },
		});
	}
	return links.map((link) => ({ ...link }));
}

export function assertWorkflowPhaseTransition(fromPhase, toPhase) {
	if (!WORKFLOW_PHASES.includes(fromPhase) || !WORKFLOW_PHASES.includes(toPhase)) {
		throw new ValidationError("Workflow phase transition requires two supported phases.");
	}
	if (fromPhase === toPhase) return { from: fromPhase, to: toPhase, changed: false };
	if (!TRANSITIONS[fromPhase].includes(toPhase)) {
		throw new ValidationError(`Workflow phase cannot transition from '${fromPhase}' to '${toPhase}'.`, {
			details: { from_phase: fromPhase, to_phase: toPhase, allowed: TRANSITIONS[fromPhase] },
		});
	}
	return { from: fromPhase, to: toPhase, changed: true };
}

export function assertWorkflowConditions(conditions, phase) {
	const metadata = {
		artifact: "workflow",
		schema_version: 1,
		id: "WF-0001",
		title: "Condition validation",
		slug: "condition-validation",
		phase,
		conditions,
		current_baseline: null,
		next_baseline_number: 1,
		next_ticket_number: 1,
		next_decision_number: 1,
		issues: [],
		git: {
			base_branch: null,
			base_commit: "0".repeat(40),
			workflow_branch: "dbz-workflows/WF-0001-condition-validation",
			integrated_commit: null,
		},
		created_at: "2000-01-01T00:00:00Z",
		updated_at: "2000-01-01T00:00:00Z",
	};
	const issues = workflowIssues(metadata).filter(({ path }) => path[0] === "conditions" || path[0] === "phase");
	if (issues.length > 0) {
		throw new SchemaValidationError(`Workflow conditions failed schema validation with ${issues.length} issue(s).`, {
			issues,
		});
	}
	return [...conditions];
}

export const WORKFLOW_PHASE_TRANSITIONS = TRANSITIONS;
