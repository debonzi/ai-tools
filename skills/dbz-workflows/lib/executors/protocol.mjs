import {
	ExecutorResultError,
	ValidationError,
} from "../errors.mjs";
import {
	validateTicketId,
	validateWorkflowId,
} from "../git-operations.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";

export const EXECUTOR_PROTOCOL_VERSION = 1;
export const EXECUTOR_OUTCOMES = Object.freeze(["done", "blocked", "failed"]);
export const EXECUTOR_RESULT_FIELDS = Object.freeze([
	"summary",
	"deliverables",
	"acceptance_criteria_evidence",
	"validation",
	"deviations",
	"follow_ups",
]);

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function singleLine(value, name) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError(`${name} must be a non-empty single-line string without NUL bytes.`);
	}
	return value.trim();
}

function markdownEvidence(value, name) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new ExecutorResultError(`${name} must contain non-empty Markdown evidence without NUL bytes.`);
	}
	const normalized = value.replace(/\r\n?/gu, "\n").trim();
	if (/^ {0,3}#{1,3}(?:[\t ]|$)/mu.test(normalized)) {
		throw new ExecutorResultError(`${name} must not define level-one through level-three headings.`);
	}
	return normalized;
}

export function normalizeExecutorIdentity({ executor, sessionId, session_id: sessionIdSnake } = {}) {
	const normalizedExecutor = singleLine(executor, "executor");
	if (!/^[a-z][a-z0-9-]*$/u.test(normalizedExecutor)) {
		throw new ValidationError("executor must be a lowercase kebab-case identifier.");
	}
	return {
		executor: normalizedExecutor,
		session_id: singleLine(sessionId ?? sessionIdSnake, "sessionId"),
	};
}

export function normalizeClaimReference(value) {
	if (!isPlainObject(value)) throw new ValidationError("claim must be a mapping.");
	const identity = normalizeExecutorIdentity(value);
	const claimId = singleLine(value.claim_id ?? value.claimId, "claim.claim_id");
	if (!isRfc3339UtcTimestamp(value.claimed_at ?? value.claimedAt)) {
		throw new ValidationError("claim.claimed_at must be an RFC 3339 UTC timestamp.");
	}
	return {
		...identity,
		claim_id: claimId,
		claimed_at: value.claimed_at ?? value.claimedAt,
	};
}

export function claimsMatch(left, right) {
	try {
		return JSON.stringify(normalizeClaimReference(left)) === JSON.stringify(normalizeClaimReference(right));
	} catch {
		return false;
	}
}

export function normalizeCommitIds(value, { allowEmpty = true, name = "worker_commits" } = {}) {
	if (!Array.isArray(value)) throw new ExecutorResultError(`${name} must be an array of full Git commit IDs.`);
	if (!allowEmpty && value.length === 0) {
		throw new ExecutorResultError(`${name} must contain at least one full Git commit ID.`);
	}
	const seen = new Set();
	let length = null;
	return value.map((commit, index) => {
		if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
			throw new ExecutorResultError(`${name}[${index}] must be a lowercase full SHA-1 or SHA-256 commit ID.`);
		}
		if (length !== null && commit.length !== length) {
			throw new ExecutorResultError(`${name} must not mix Git object formats.`);
		}
		if (seen.has(commit)) throw new ExecutorResultError(`${name} contains duplicate commit '${commit}'.`);
		length = commit.length;
		seen.add(commit);
		return commit;
	});
}

export function normalizeExecutorResult(value, { requireWorkerCommits = false } = {}) {
	if (!isPlainObject(value)) throw new ExecutorResultError("Executor result must be a mapping.");
	if (value.protocol_version !== EXECUTOR_PROTOCOL_VERSION) {
		throw new ExecutorResultError(`Executor result protocol_version must be ${EXECUTOR_PROTOCOL_VERSION}.`);
	}
	try {
		validateWorkflowId(value.workflow_id);
		validateTicketId(value.ticket_id);
	} catch (error) {
		throw new ExecutorResultError("Executor result must reference canonical workflow and ticket IDs.", { cause: error });
	}
	if (!EXECUTOR_OUTCOMES.includes(value.outcome)) {
		throw new ExecutorResultError(`Executor outcome must be one of: ${EXECUTOR_OUTCOMES.join(", ")}.`);
	}
	const reason = value.outcome === "done"
		? null
		: singleLine(value.reason, "Executor result reason");
	if (value.outcome === "done" && value.reason !== undefined && value.reason !== null) {
		throw new ExecutorResultError("A done executor result must not include a blocked or failure reason.");
	}
	const normalized = {
		protocol_version: EXECUTOR_PROTOCOL_VERSION,
		workflow_id: value.workflow_id,
		ticket_id: value.ticket_id,
		claim: normalizeClaimReference(value.claim),
		outcome: value.outcome,
		reason,
	};
	for (const field of EXECUTOR_RESULT_FIELDS) {
		const camel = field.replace(/_([a-z])/gu, (_match, letter) => letter.toUpperCase());
		normalized[field] = markdownEvidence(value[field] ?? value[camel], field);
	}
	normalized.worker_commits = normalizeCommitIds(
		value.worker_commits ?? value.workerCommits ?? [],
		{
			allowEmpty: !(requireWorkerCommits && value.outcome === "done"),
			name: "worker_commits",
		},
	);
	return normalized;
}

export function createExecutorResult(input, options = {}) {
	if (!isPlainObject(input)) throw new ExecutorResultError("Executor result input must be a mapping.");
	return normalizeExecutorResult({
		...input,
		protocol_version: EXECUTOR_PROTOCOL_VERSION,
		workflow_id: input.workflow_id ?? input.workflowId,
		ticket_id: input.ticket_id ?? input.ticketId,
		worker_commits: input.worker_commits ?? input.workerCommits ?? [],
	}, options);
}
