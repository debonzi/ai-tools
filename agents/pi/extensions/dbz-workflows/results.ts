import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ValidationError } from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { createExecutorResult } from "../../../../skills/dbz-workflows/lib/executors/protocol.mjs";
import { assertDialogUI } from "./ui.ts";

export interface ExecutorResultInput {
	outcome: "done" | "blocked" | "failed";
	reason?: string;
	summary: string;
	deliverables: string;
	acceptance_criteria_evidence: string;
	validation: string;
	deviations: string;
	follow_ups: string;
	worker_commits?: string[];
}

function activeSessionId(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId();
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new ValidationError("DBZ Workflows result operations require a persistent Pi session ID.");
	}
	return sessionId;
}

export function createCurrentSessionExecutorResult(
	ctx: ExtensionContext,
	ticket: any,
	input: ExecutorResultInput,
	createResult: typeof createExecutorResult = createExecutorResult,
): ReturnType<typeof createExecutorResult> {
	const sessionId = activeSessionId(ctx);
	const claim = ticket?.execution?.claim;
	if (
		claim?.executor !== "manual" ||
		claim?.session_id !== sessionId ||
		ticket.status !== "in-progress"
	) {
		throw new ValidationError(
			"dbz_workflows_submit_result may submit only the active manual claim owned by the current dedicated Pi session.",
		);
	}
	return createResult({
		workflow_id: ticket.metadata.workflow_id,
		ticket_id: ticket.id,
		claim,
		outcome: input.outcome,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		summary: input.summary,
		deliverables: input.deliverables,
		acceptance_criteria_evidence: input.acceptance_criteria_evidence,
		validation: input.validation,
		deviations: input.deviations,
		follow_ups: input.follow_ups,
		worker_commits: input.worker_commits ?? [],
	}, { requireWorkerCommits: ticket.type === "implementation" || ticket.type === "documentation" });
}

export function submittedResultResponse(applied: any, workflowId: string, ticketId: string): any {
	return {
		...applied,
		return_to_coordination: {
			required: true,
			command: `/dbz-workflows continue ${workflowId}`,
			message: `Result submitted for ${workflowId}/${ticketId}. The executor has no completion authority; return to coordination for review and acceptance.`,
		},
	};
}

function resultClaim(ticket: any): any {
	return ticket?.execution?.result?.claim ?? null;
}

export async function prepareCoordinatorAcceptance(
	ctx: ExtensionContext,
	ticket: any,
): Promise<{ confirmed: true; approved_by: "user" } | undefined> {
	const submittedClaim = resultClaim(ticket);
	if (submittedClaim?.session_id === activeSessionId(ctx)) {
		throw new ValidationError(
			"The executor session that submitted a result cannot accept or complete its own canonical ticket. Return to a coordination session first.",
		);
	}
	if (ticket.type !== "question-session") return undefined;
	assertDialogUI(ctx, "Question-session result acceptance");
	const confirmed = await ctx.ui.confirm(
		`Accept human answers for ${ticket.id}?`,
		"Confirm that the recorded questions, answers, unresolved items, and resulting decisions are accurate.",
	);
	if (!confirmed) throw new ValidationError("Question-session acceptance was not confirmed.");
	return { confirmed: true, approved_by: "user" };
}

export function assertResultReadyForCoordination(
	ticket: any,
	expectedClaimId: string,
): { outcome: "done" | "blocked" | "failed"; claim: any } {
	const result = ticket?.execution?.result;
	if (
		result === null ||
		typeof result !== "object" ||
		!["done", "blocked", "failed"].includes(result.outcome) ||
		result.claim?.claim_id !== expectedClaimId
	) {
		throw new ValidationError(
			`Ticket '${ticket?.id ?? "unknown"}' must contain a submitted executor result for the active ticket-session claim before returning to coordination.`,
		);
	}
	return { outcome: result.outcome, claim: result.claim };
}

export function coordinatorHandoffPrompt(
	ticket: any,
	outcome: string,
	{
		integration,
		integrationError,
	}: {
		integration?: { action: string; integrated_commits: string[]; worktree_removed: boolean };
		integrationError?: string;
	} = {},
): string {
	const workflowId = ticket?.metadata?.workflow_id;
	const integrationMessage = integrationError !== undefined
		? `Mutating-result integration is blocked: ${integrationError}`
		: integration?.action === "integrated"
			? `Final integrated commits: ${integration.integrated_commits.join(", ")}. Ticket worktree cleanup: ${integration.worktree_removed ? "completed" : "explicitly retained"}.`
			: integration?.action === "integration_cancelled"
				? "Mutating-result integration was not confirmed and must be retried explicitly before acceptance."
				: undefined;
	return [
		`Continue coordination for ${workflowId}/${ticket.id}.`,
		`The dedicated executor submitted a canonical '${outcome}' result.`,
		"Inspect the ticket Result and evidence from canonical artifacts; do not depend on the executor transcript.",
		...(integrationMessage === undefined ? [] : [integrationMessage]),
		outcome === "done"
			? "Verify deliverables, acceptance criteria, validation, and final integrated commits, then use dbz_workflows_accept_result only if every core acceptance check is satisfied."
			: "Triage the recorded blocker or failure and re-plan explicitly. Do not mark the ticket completed.",
	].join(" ");
}
