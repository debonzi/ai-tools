import { Buffer } from "node:buffer";
import {
	ContextBudgetError,
	ValidationError,
} from "./errors.mjs";
import {
	normalizeTicketMetadata,
	validateContextBudgetException,
	validateTicketMetadata,
} from "./schemas/ticket.mjs";

export const DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS = 64_000;
export const MAX_INITIAL_CONTEXT_BUDGET_TOKENS = 32_000;
export const INITIAL_CONTEXT_WINDOW_FRACTION = 0.25;
const PACKET_OVERHEAD_TOKENS = 32;
const SEGMENT_OVERHEAD_TOKENS = 12;

function requirePositiveInteger(value, name) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ValidationError(`${name} must be a positive safe integer.`);
	}
	return value;
}

export function calculateInitialContextBudget(contextWindowTokens) {
	const fallback = contextWindowTokens === undefined || contextWindowTokens === null;
	const contextWindow = fallback
		? DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS
		: requirePositiveInteger(contextWindowTokens, "contextWindowTokens");
	return {
		context_window_tokens: contextWindow,
		budget_tokens: Math.min(
			Math.floor(contextWindow * INITIAL_CONTEXT_WINDOW_FRACTION),
			MAX_INITIAL_CONTEXT_BUDGET_TOKENS,
		),
		source: fallback ? "conservative_fallback" : "active_model",
	};
}

export function estimateTextTokens(value) {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new ValidationError("Context text must be a string without NUL bytes.");
	}
	if (value.length === 0) return 0;
	// A UTF-8 byte upper-bound is deliberately conservative and tokenizer-independent.
	return Buffer.byteLength(value, "utf8");
}

function normalizeSegments(ticketSource, referencedContents) {
	if (typeof ticketSource !== "string" || ticketSource.includes("\0")) {
		throw new ValidationError("ticketSource must be Markdown without NUL bytes.");
	}
	if (!Array.isArray(referencedContents)) {
		throw new ValidationError("referencedContents must be an array.");
	}
	const segments = [{ kind: "ticket", id: "ticket", content: ticketSource }];
	const seen = new Set(["ticket:ticket"]);
	for (let index = 0; index < referencedContents.length; index += 1) {
		const segment = referencedContents[index];
		if (segment === null || typeof segment !== "object" || Array.isArray(segment)) {
			throw new ValidationError(`Referenced context segment at index ${index} must be an object.`);
		}
		if (
			typeof segment.kind !== "string" ||
			!/^[a-z][a-z0-9_]*$/u.test(segment.kind) ||
			typeof segment.id !== "string" ||
			segment.id.trim().length === 0 ||
			/[\r\n\0]/u.test(segment.id)
		) {
			throw new ValidationError(`Referenced context segment at index ${index} has an invalid kind or id.`);
		}
		if (typeof segment.content !== "string" || segment.content.includes("\0")) {
			throw new ValidationError(`Referenced context segment '${segment.kind}:${segment.id}' must contain safe text.`);
		}
		const key = `${segment.kind}:${segment.id}`;
		if (seen.has(key)) throw new ValidationError(`Referenced context segment '${key}' is duplicated.`);
		seen.add(key);
		segments.push({ kind: segment.kind, id: segment.id, content: segment.content });
	}
	return segments;
}

export function evaluateContextBudget({
	ticketSource,
	referencedContents = [],
	contextWindowTokens,
	contextBudgetException = null,
}) {
	validateContextBudgetException(contextBudgetException);
	const budget = calculateInitialContextBudget(contextWindowTokens);
	const segments = normalizeSegments(ticketSource, referencedContents).map(({ kind, id, content }) => ({
		kind,
		id,
		estimated_tokens: estimateTextTokens(content) + SEGMENT_OVERHEAD_TOKENS,
	}));
	const estimatedTokens = PACKET_OVERHEAD_TOKENS + segments.reduce(
		(total, segment) => total + segment.estimated_tokens,
		0,
	);
	const withinBudget = estimatedTokens <= budget.budget_tokens;
	const exceptionApplied = !withinBudget && contextBudgetException !== null;
	return {
		...budget,
		estimator: "utf8_byte_upper_bound_v1",
		estimated_tokens: estimatedTokens,
		within_budget: withinBudget,
		exception_applied: exceptionApplied,
		ready: withinBudget || exceptionApplied,
		segments,
	};
}

export function assertContextBudget(input) {
	const evaluation = evaluateContextBudget(input);
	if (!evaluation.ready) {
		throw new ContextBudgetError(
			`Initial ticket context is estimated at ${evaluation.estimated_tokens} tokens, exceeding the ${evaluation.budget_tokens}-token budget. Split the ticket or record an explicitly user-approved context_budget_exception.`,
			{
				details: {
					estimated_tokens: evaluation.estimated_tokens,
					budget_tokens: evaluation.budget_tokens,
					context_window_tokens: evaluation.context_window_tokens,
				},
			},
		);
	}
	return evaluation;
}

export function extractContextReferences(ticketMetadata) {
	const normalized = validateTicketMetadata(normalizeTicketMetadata(ticketMetadata));
	return {
		spec_sections: [...normalized.context.spec_sections],
		decisions: [...normalized.context.decisions],
		tickets: [...normalized.context.tickets],
		files: [...normalized.context.files],
		repository_files_deferred: true,
	};
}
