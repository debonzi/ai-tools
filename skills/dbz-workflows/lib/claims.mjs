import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
	canonicalTimestamp,
	requireArtifactDigest,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import {
	ClaimError,
	ERROR_CODES,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
} from "./filesystem.mjs";
import { patchFrontmatter } from "./frontmatter.mjs";
import { replaceLevelTwoSection } from "./markdown.mjs";
import { validateTicketDag } from "./dag.mjs";
import {
	assertTicketStatusTransition,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";
import {
	inspectTicketInContext,
	listTicketsInContext,
	parseTicketArtifact,
	queryTicketReadinessInContext,
} from "./tickets.mjs";
import {
	normalizeExecutorIdentity,
	normalizeClaimReference,
} from "./executors/protocol.mjs";
import { validateTicketId } from "./schemas/identifiers.mjs";

function normalizeRationale(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Claim recovery rationale must be a non-empty single-line string without NUL bytes.");
	}
	return value.trim();
}

function requireTicket(tickets, workflowId, ticketId) {
	const ticket = tickets.find(({ id }) => id === ticketId);
	if (ticket === undefined) {
		throw new ClaimError(`Ticket '${ticketId}' was not found in workflow '${workflowId}'.`, {
			code: ERROR_CODES.TICKET_NOT_FOUND,
		});
	}
	return ticket;
}

function assertExpectedDigest(ticket, expectedDigest) {
	if (ticket.digest !== expectedDigest) {
		throw new RevisionConflictError(`Ticket '${ticket.id}' does not match the expected revision.`, {
			details: { expected_digest: expectedDigest, actual_digest: ticket.digest },
		});
	}
}

async function readExpectedTicketSource(ticket) {
	const snapshot = await readFileWithDigest(ticket.path, { encoding: "utf8" });
	if (snapshot.digest !== ticket.digest) {
		throw new RevisionConflictError(`Ticket '${ticket.id}' changed while its claim was being prepared.`, {
			details: { expected_digest: ticket.digest, actual_digest: snapshot.digest },
		});
	}
	return snapshot.data;
}

function validateClaimId(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("claimIdFactory must return a non-empty single-line claim ID.");
	}
	return value.trim();
}

function replacementTicket(ticket, parsed) {
	return {
		...ticket,
		status: parsed.data.status,
		execution: parsed.data.execution,
		metadata: parsed.data,
	};
}

export async function claimTicket(
	identity,
	workflowId,
	ticketId,
	{
		expectedTicketDigest,
		executor,
		sessionId,
		homeDirectory = homedir(),
		clock = () => new Date(),
		claimIdFactory = () => randomUUID(),
		lockOptions,
		contextWindowTokens,
		externalBlocks = [],
	} = {},
) {
	validateTicketId(ticketId);
	const digest = requireArtifactDigest(expectedTicketDigest, "expectedTicketDigest");
	const executorIdentity = normalizeExecutorIdentity({ executor, sessionId });
	if (typeof claimIdFactory !== "function") throw new ValidationError("claimIdFactory must be a function.");
	const timestamp = canonicalTimestamp(clock);
	const claim = normalizeClaimReference({
		...executorIdentity,
		claim_id: validateClaimId(claimIdFactory()),
		claimed_at: timestamp,
	});
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		const tickets = await listTicketsInContext(context);
		const ticket = requireTicket(tickets, workflowId, ticketId);
		assertExpectedDigest(ticket, digest);
		if (ticket.execution.claim !== null) {
			throw new ClaimError(`Ticket '${ticketId}' is already claimed and claims never expire automatically.`, {
				details: { ticket_id: ticketId, claim: { ...ticket.execution.claim } },
			});
		}
		if (ticket.status !== "open") {
			throw new ClaimError(`Ticket '${ticketId}' must be open before it can be claimed.`, {
				details: { ticket_id: ticketId, status: ticket.status },
			});
		}
		if (executorIdentity.executor !== "manual" && ticket.execution.mode !== "delegatable") {
			throw new ClaimError(`Ticket '${ticketId}' permits only manual execution.`);
		}
		const readiness = await queryTicketReadinessInContext(context, {
			contextWindowTokens,
			externalBlocks,
		});
		const ticketReadiness = readiness.tickets.find(({ id }) => id === ticketId);
		if (ticketReadiness?.actionable !== true) {
			throw new ClaimError(`Ticket '${ticketId}' cannot be claimed because it is not actionable.`, {
				details: { reasons: ticketReadiness?.reasons ?? [{ code: "missing_readiness" }] },
			});
		}
		assertTicketStatusTransition(ticket.status, "in-progress");
		const source = await readExpectedTicketSource(ticket);
		let replacement = patchFrontmatter(source, [
			{ path: ["status"], value: "in-progress" },
			{ path: ["execution", "claim"], value: claim },
			{ path: ["execution", "result"], operation: "delete" },
			{ path: ["execution", "acceptance"], operation: "delete" },
			{ path: ["status_reason"], operation: "delete" },
			{ path: ["updated_at"], value: timestamp },
		], { path: ticket.path });
		replacement = replaceLevelTwoSection(replacement, "Result", "", { path: ticket.path });
		const parsed = parseTicketArtifact(replacement, {
			path: ticket.path,
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: workflowId,
		});
		validateTicketMetadata(parsed.data);
		validateTicketDag(
			tickets.map((candidate) => candidate.id === ticketId ? replacementTicket(candidate, parsed) : candidate),
			{ workflowId },
		);
		await atomicWriteFile(ticket.path, replacement, {
			expectedDigest: ticket.digest,
			root: context.storage.effectivePath,
		});
		return {
			changed: true,
			claim,
			ticket: await inspectTicketInContext(context, ticketId),
			readiness: ticketReadiness,
		};
	}, { homeDirectory, lockOptions });
}

function validateRecoveryAuthorization(value, claim) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.confirmed !== true ||
		value.recovered_by !== "user" ||
		value.claim_id !== claim.claim_id
	) {
		throw new ClaimError(
			"Claim recovery requires explicit user confirmation tied to the active claim ID.",
			{
				code: ERROR_CODES.CLAIM_RECOVERY_REQUIRED,
				details: { claim_id: claim.claim_id },
			},
		);
	}
	return { confirmed: true, recovered_by: "user", claim_id: value.claim_id };
}

export async function recoverTicketClaim(
	identity,
	workflowId,
	ticketId,
	{
		expectedTicketDigest,
		rationale,
		toStatus = "open",
		authorization,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	validateTicketId(ticketId);
	const digest = requireArtifactDigest(expectedTicketDigest, "expectedTicketDigest");
	const reason = normalizeRationale(rationale);
	if (toStatus !== "open" && toStatus !== "blocked") {
		throw new ValidationError("Claim recovery toStatus must be 'open' or 'blocked'.");
	}
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		const tickets = await listTicketsInContext(context);
		const ticket = requireTicket(tickets, workflowId, ticketId);
		assertExpectedDigest(ticket, digest);
		if (ticket.execution.claim === null) throw new ClaimError(`Ticket '${ticketId}' has no active claim to recover.`);
		if (ticket.status !== "in-progress") {
			throw new ClaimError(`Ticket '${ticketId}' claim recovery requires in-progress status.`, {
				details: { status: ticket.status },
			});
		}
		const claim = normalizeClaimReference(ticket.execution.claim);
		validateRecoveryAuthorization(authorization, claim);
		assertTicketStatusTransition(ticket.status, toStatus);
		const recoveries = ticket.execution.claim_recoveries ?? [];
		if (!Array.isArray(recoveries)) {
			throw new ClaimError(`Ticket '${ticketId}' has invalid claim recovery metadata; repair it explicitly before recovery.`);
		}
		const recovery = {
			claim,
			rationale: reason,
			recovered_by: "user",
			recovered_at: timestamp,
		};
		const source = await readExpectedTicketSource(ticket);
		let replacement = patchFrontmatter(source, [
			{ path: ["status"], value: toStatus },
			{ path: ["execution", "claim"], value: null },
			{ path: ["execution", "claim_recoveries"], value: [...recoveries, recovery] },
			{ path: ["execution", "result"], operation: "delete" },
			{ path: ["execution", "acceptance"], operation: "delete" },
			{
				path: ["status_reason"],
				value: { rationale: reason, recorded_at: timestamp },
			},
			{ path: ["updated_at"], value: timestamp },
		], { path: ticket.path });
		replacement = replaceLevelTwoSection(replacement, "Result", "", { path: ticket.path });
		const parsed = parseTicketArtifact(replacement, {
			path: ticket.path,
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: workflowId,
		});
		validateTicketDag(
			tickets.map((candidate) => candidate.id === ticketId ? replacementTicket(candidate, parsed) : candidate),
			{ workflowId },
		);
		await atomicWriteFile(ticket.path, replacement, {
			expectedDigest: ticket.digest,
			root: context.storage.effectivePath,
		});
		return {
			changed: true,
			recovery,
			ticket: await inspectTicketInContext(context, ticketId),
		};
	}, { homeDirectory, lockOptions });
}
