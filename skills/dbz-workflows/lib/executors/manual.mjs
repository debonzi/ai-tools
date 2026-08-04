import { claimTicket } from "../claims.mjs";
import {
	ExecutorResultError,
	ValidationError,
} from "../errors.mjs";
import { isProjectMutatingTicket } from "../schemas/ticket.mjs";
import {
	createExecutorResult,
	normalizeClaimReference,
} from "./protocol.mjs";

export const MANUAL_EXECUTOR = "manual";

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export async function startManualExecution(
	identity,
	workflowId,
	ticketId,
	{
		sessionId,
		...options
	} = {},
) {
	const claimed = await claimTicket(identity, workflowId, ticketId, {
		...options,
		executor: MANUAL_EXECUTOR,
		sessionId,
	});
	return {
		protocol_version: 1,
		executor: MANUAL_EXECUTOR,
		workflow_id: workflowId,
		ticket_id: ticketId,
		ticket_type: claimed.ticket.type,
		mutates_project: isProjectMutatingTicket(claimed.ticket.metadata),
		claim: normalizeClaimReference(claimed.claim),
		ticket_digest: claimed.ticket.digest,
		status: "claimed",
		canonical_completion_authority: "coordinator",
	};
}

export function createManualExecutorResult(execution, resultInput) {
	if (!isPlainObject(execution) || execution.executor !== MANUAL_EXECUTOR || execution.status !== "claimed") {
		throw new ValidationError("execution must be a claimed manual-executor request.");
	}
	if (!isPlainObject(resultInput)) throw new ExecutorResultError("Manual executor result input must be a mapping.");
	return createExecutorResult({
		...resultInput,
		workflow_id: execution.workflow_id,
		ticket_id: execution.ticket_id,
		claim: execution.claim,
	}, {
		requireWorkerCommits: execution.mutates_project === true,
	});
}
