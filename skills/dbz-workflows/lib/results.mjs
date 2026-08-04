import { homedir } from "node:os";
import {
	canonicalTimestamp,
	requireArtifactDigest,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import { validateTicketDag } from "./dag.mjs";
import {
	ERROR_CODES,
	ExecutorResultError,
	ResultAcceptanceError,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";
import {
	claimsMatch,
	EXECUTOR_RESULT_FIELDS,
	normalizeCommitIds,
	normalizeExecutorResult,
} from "./executors/protocol.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	sha256Hex,
} from "./filesystem.mjs";
import { patchFrontmatter } from "./frontmatter.mjs";
import { discoverIntegratedTicketCommits } from "./git-operations.mjs";
import {
	readLevelTwoSection,
	replaceLevelTwoSection,
} from "./markdown.mjs";
import { validateTicketId } from "./schemas/identifiers.mjs";
import {
	assertTicketStatusTransition,
	isProjectMutatingTicket,
} from "./schemas/ticket.mjs";
import {
	inspectTicketInContext,
	listTicketsInContext,
	parseTicketArtifact,
} from "./tickets.mjs";

const RESULT_HEADINGS = Object.freeze([
	["Summary", "summary"],
	["Deliverables", "deliverables"],
	["Commits", "worker_commits"],
	["Acceptance Criteria Evidence", "acceptance_criteria_evidence"],
	["Validation", "validation"],
	["Deviations", "deviations"],
	["Follow-ups", "follow_ups"],
]);
const INTEGRATED_COMMITS_HEADING = "Integrated Commits";

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function commitEvidence(commits, emptyMessage) {
	return commits.length === 0
		? emptyMessage
		: commits.map((commit) => `- \`${commit}\``).join("\n");
}

export function renderExecutorResultSection(resultValue, { integratedCommits } = {}) {
	const result = normalizeExecutorResult(resultValue);
	const integrated = integratedCommits === undefined
		? null
		: normalizeCommitIds(integratedCommits, { name: "integrated_commits" });
	const blocks = [];
	for (const [heading, field] of RESULT_HEADINGS) {
		blocks.push(`### ${heading}`);
		blocks.push("");
		if (field === "worker_commits") {
			blocks.push(commitEvidence(result.worker_commits, "No commits were reported."));
		} else {
			blocks.push(result[field]);
		}
		blocks.push("");
		if (heading === "Commits" && integrated !== null) {
			blocks.push(`### ${INTEGRATED_COMMITS_HEADING}`);
			blocks.push("");
			blocks.push(commitEvidence(integrated, "No integrated commits are required for this read-only ticket."));
			blocks.push("");
		}
	}
	return `${blocks.join("\n").trimEnd()}\n`;
}

function indexResultSubsections(content) {
	const normalized = content.replace(/\r\n?/gu, "\n");
	const expression = /^ {0,3}###[\t ]+(.+?)[\t ]*#*[\t ]*$/gmu;
	const headings = [];
	let match;
	while ((match = expression.exec(normalized)) !== null) {
		const lineEnd = normalized.indexOf("\n", match.index);
		headings.push({
			title: match[1].trim(),
			start: match.index,
			contentStart: lineEnd === -1 ? normalized.length : lineEnd + 1,
		});
	}
	return { normalized, headings };
}

export function validateExecutorResultSection(source, { path } = {}) {
	const content = readLevelTwoSection(source, "Result", { includeHeading: false, path });
	const indexed = indexResultSubsections(content);
	const allowed = new Set([...RESULT_HEADINGS.map(([heading]) => heading), INTEGRATED_COMMITS_HEADING]);
	const expectedOrder = RESULT_HEADINGS.map(([heading]) => heading);
	const seen = new Set();
	const sections = {};
	let previous = -1;
	for (let index = 0; index < indexed.headings.length; index += 1) {
		const heading = indexed.headings[index];
		if (!allowed.has(heading.title)) {
			throw new ExecutorResultError(`Ticket Result contains unsupported subsection '${heading.title}'.`);
		}
		if (seen.has(heading.title)) {
			throw new ExecutorResultError(`Ticket Result contains duplicate subsection '${heading.title}'.`);
		}
		seen.add(heading.title);
		const end = indexed.headings[index + 1]?.start ?? indexed.normalized.length;
		const value = indexed.normalized.slice(heading.contentStart, end).trim();
		if (value.length === 0) {
			throw new ExecutorResultError(`Ticket Result subsection '${heading.title}' must contain evidence.`);
		}
		sections[heading.title] = value;
		const expectedIndex = expectedOrder.indexOf(heading.title);
		if (expectedIndex !== -1) {
			if (expectedIndex <= previous) {
				throw new ExecutorResultError("Ticket Result subsections are not in the required protocol order.");
			}
			previous = expectedIndex;
		}
	}
	for (const heading of expectedOrder) {
		if (!seen.has(heading)) throw new ExecutorResultError(`Ticket Result is missing required subsection '${heading}'.`);
	}
	if (
		seen.has(INTEGRATED_COMMITS_HEADING) &&
		indexed.headings.findIndex(({ title }) => title === INTEGRATED_COMMITS_HEADING) !==
			indexed.headings.findIndex(({ title }) => title === "Commits") + 1
	) {
		throw new ExecutorResultError(`Ticket Result subsection '${INTEGRATED_COMMITS_HEADING}' must follow 'Commits'.`);
	}
	return {
		valid: true,
		content,
		body_sha256: sha256Hex(content),
		sections,
		accepted: seen.has(INTEGRATED_COMMITS_HEADING),
	};
}

function requireTicket(tickets, workflowId, ticketId) {
	const ticket = tickets.find(({ id }) => id === ticketId);
	if (ticket === undefined) {
		throw new ExecutorResultError(`Ticket '${ticketId}' was not found in workflow '${workflowId}'.`, {
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

async function readExpectedSource(ticket) {
	const snapshot = await readFileWithDigest(ticket.path, { encoding: "utf8" });
	if (snapshot.digest !== ticket.digest) {
		throw new RevisionConflictError(`Ticket '${ticket.id}' changed while its executor result was being prepared.`, {
			details: { expected_digest: ticket.digest, actual_digest: snapshot.digest },
		});
	}
	return snapshot.data;
}

function replacementTicket(ticket, parsed) {
	return {
		...ticket,
		status: parsed.data.status,
		execution: parsed.data.execution,
		metadata: parsed.data,
	};
}

function failedStatus(value, outcome) {
	if (outcome !== "failed") {
		if (value !== undefined) throw new ValidationError("failedDisposition is valid only for a failed executor result.");
		return outcome === "blocked" ? "blocked" : "in-progress";
	}
	const normalized = value ?? "open";
	if (normalized !== "open" && normalized !== "blocked") {
		throw new ValidationError("failedDisposition must be 'open' or 'blocked'.");
	}
	return normalized;
}

export async function applyExecutorResult(
	identity,
	workflowId,
	ticketId,
	resultValue,
	{
		expectedTicketDigest,
		failedDisposition,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	validateTicketId(ticketId);
	const digest = requireArtifactDigest(expectedTicketDigest, "expectedTicketDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		const tickets = await listTicketsInContext(context);
		const ticket = requireTicket(tickets, workflowId, ticketId);
		assertExpectedDigest(ticket, digest);
		const result = normalizeExecutorResult(resultValue, {
			requireWorkerCommits: isProjectMutatingTicket(ticket.metadata),
		});
		if (result.workflow_id !== workflowId || result.ticket_id !== ticketId) {
			throw new ExecutorResultError("Executor result identity does not match the selected workflow ticket.", {
				details: {
					expected_workflow_id: workflowId,
					expected_ticket_id: ticketId,
					actual_workflow_id: result.workflow_id,
					actual_ticket_id: result.ticket_id,
				},
			});
		}
		if (ticket.status !== "in-progress" || ticket.execution.claim === null) {
			throw new ExecutorResultError(`Ticket '${ticketId}' must have an active in-progress claim before result application.`);
		}
		if (!claimsMatch(ticket.execution.claim, result.claim)) {
			throw new ExecutorResultError(`Executor result claim does not match the active claim for ticket '${ticketId}'.`);
		}
		if (ticket.execution.result !== undefined) {
			throw new ExecutorResultError(`Ticket '${ticketId}' already has a result for its active claim.`);
		}
		const toStatus = failedStatus(failedDisposition, result.outcome);
		if (toStatus !== ticket.status) assertTicketStatusTransition(ticket.status, toStatus);
		const section = renderExecutorResultSection(result);
		const resultMetadata = {
			protocol_version: result.protocol_version,
			outcome: result.outcome,
			claim: result.claim,
			submitted_at: timestamp,
			worker_commits: result.worker_commits,
			body_sha256: sha256Hex(`\n${section}`),
		};
		const patches = [
			{ path: ["status"], value: toStatus },
			{ path: ["execution", "result"], value: resultMetadata },
			{ path: ["execution", "acceptance"], operation: "delete" },
			{ path: ["updated_at"], value: timestamp },
		];
		if (result.outcome === "done") {
			patches.push({ path: ["status_reason"], operation: "delete" });
		} else {
			patches.push(
				{ path: ["execution", "claim"], value: null },
				{
					path: ["status_reason"],
					value: { rationale: result.reason, recorded_at: timestamp },
				},
			);
		}
		const source = await readExpectedSource(ticket);
		let replacement = patchFrontmatter(source, patches, { path: ticket.path });
		replacement = replaceLevelTwoSection(replacement, "Result", `\n${section}`, { path: ticket.path });
		const parsed = parseTicketArtifact(replacement, {
			path: ticket.path,
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: workflowId,
		});
		const protocol = validateExecutorResultSection(replacement, { path: ticket.path });
		if (protocol.body_sha256 !== resultMetadata.body_sha256) {
			throw new ExecutorResultError("Rendered executor result digest is inconsistent.");
		}
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
			outcome: result.outcome,
			completion_allowed: false,
			claim_released: result.outcome !== "done",
			ticket: await inspectTicketInContext(context, ticketId),
		};
	}, { homeDirectory, lockOptions });
}

function normalizeAcceptance(value, mutating) {
	if (!isPlainObject(value)) throw new ResultAcceptanceError("Coordinator acceptance checks must be a mapping.");
	for (const field of ["deliverables_verified", "acceptance_criteria_verified", "validation_verified"]) {
		const camel = field.replace(/_([a-z])/gu, (_match, letter) => letter.toUpperCase());
		if ((value[field] ?? value[camel]) !== true) {
			throw new ResultAcceptanceError(`Coordinator acceptance requires ${field}: true.`);
		}
	}
	const integrated = normalizeCommitIds(
		value.integrated_commits ?? value.integratedCommits ?? [],
		{ allowEmpty: !mutating, name: "integrated_commits" },
	);
	if (!mutating && integrated.length > 0) {
		throw new ResultAcceptanceError("Read-only ticket acceptance must not record project integrated commits.");
	}
	return {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: integrated,
	};
}

function normalizeHumanApproval(value, required) {
	if (!required && value === undefined) return null;
	if (
		!isPlainObject(value) ||
		value.confirmed !== true ||
		value.approved_by !== "user"
	) {
		throw new ResultAcceptanceError("This ticket requires explicit human approval recorded as approved_by 'user'.");
	}
	return { confirmed: true, approved_by: "user" };
}

function resultValueFromProtocol(ticket, protocol) {
	const resultMetadata = ticket.execution.result;
	return normalizeExecutorResult({
		protocol_version: resultMetadata.protocol_version,
		workflow_id: ticket.metadata.workflow_id,
		ticket_id: ticket.id,
		claim: resultMetadata.claim,
		outcome: resultMetadata.outcome,
		reason: null,
		summary: protocol.sections.Summary,
		deliverables: protocol.sections.Deliverables,
		acceptance_criteria_evidence: protocol.sections["Acceptance Criteria Evidence"],
		validation: protocol.sections.Validation,
		deviations: protocol.sections.Deviations,
		follow_ups: protocol.sections["Follow-ups"],
		worker_commits: resultMetadata.worker_commits,
	});
}

function sameCommits(left, right) {
	return left.length === right.length && left.every((commit, index) => commit === right[index]);
}

export async function acceptExecutorResult(
	identity,
	workflowId,
	ticketId,
	acceptanceValue,
	{
		expectedTicketDigest,
		humanApproval,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	validateTicketId(ticketId);
	const digest = requireArtifactDigest(expectedTicketDigest, "expectedTicketDigest");
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		const tickets = await listTicketsInContext(context);
		const ticket = requireTicket(tickets, workflowId, ticketId);
		assertExpectedDigest(ticket, digest);
		if (
			ticket.status !== "in-progress" ||
			ticket.execution.claim === null ||
			!isPlainObject(ticket.execution.result) ||
			ticket.execution.result.outcome !== "done"
		) {
			throw new ResultAcceptanceError(`Ticket '${ticketId}' requires an applied done result under its active claim before acceptance.`);
		}
		if (!claimsMatch(ticket.execution.claim, ticket.execution.result.claim)) {
			throw new ResultAcceptanceError(`Ticket '${ticketId}' result no longer matches its active claim.`);
		}
		const mutating = isProjectMutatingTicket(ticket.metadata);
		const acceptance = normalizeAcceptance(acceptanceValue, mutating);
		const approval = normalizeHumanApproval(humanApproval, ticket.type === "question-session");
		const source = await readExpectedSource(ticket);
		const protocol = validateExecutorResultSection(source, { path: ticket.path });
		if (protocol.accepted) {
			throw new ResultAcceptanceError(`Ticket '${ticketId}' Result already contains coordinator integration evidence.`);
		}
		if (protocol.body_sha256 !== ticket.execution.result.body_sha256) {
			throw new ResultAcceptanceError(`Ticket '${ticketId}' Result changed after executor submission; reapply a reviewed result before acceptance.`);
		}
		let integration = null;
		if (mutating) {
			integration = await discoverIntegratedTicketCommits(context.identity.projectRoot, {
				fromCommit: context.workflow.metadata.git.base_commit,
				integrationRef: context.workflow.metadata.git.workflow_branch,
				workflowId,
				ticketId,
				requireAny: true,
			});
			if (!sameCommits(acceptance.integrated_commits, integration.commits)) {
				throw new ResultAcceptanceError(
					"Coordinator acceptance must record exactly the final ticket commits integrated into the workflow branch.",
					{
						details: {
							provided_commits: acceptance.integrated_commits,
							discovered_commits: integration.commits,
							workflow_branch: context.workflow.metadata.git.workflow_branch,
						},
					},
				);
			}
		}
		const submittedResult = resultValueFromProtocol(ticket, protocol);
		const acceptedSection = renderExecutorResultSection(submittedResult, {
			integratedCommits: acceptance.integrated_commits,
		});
		const acceptedResultMetadata = {
			...ticket.execution.result,
			accepted_at: timestamp,
			integrated_commits: acceptance.integrated_commits,
			body_sha256: sha256Hex(`\n${acceptedSection}`),
		};
		const acceptanceMetadata = {
			...acceptance,
			accepted_by: "coordinator",
			accepted_at: timestamp,
			...(approval === null ? {} : { human_approval: { ...approval, approved_at: timestamp } }),
		};
		assertTicketStatusTransition(ticket.status, "completed");
		let replacement = patchFrontmatter(source, [
			{ path: ["status"], value: "completed" },
			{ path: ["execution", "claim"], value: null },
			{ path: ["execution", "result"], value: acceptedResultMetadata },
			{ path: ["execution", "acceptance"], value: acceptanceMetadata },
			{ path: ["status_reason"], operation: "delete" },
			{ path: ["updated_at"], value: timestamp },
		], { path: ticket.path });
		replacement = replaceLevelTwoSection(replacement, "Result", `\n${acceptedSection}`, { path: ticket.path });
		const parsed = parseTicketArtifact(replacement, {
			path: ticket.path,
			expectedId: ticket.id,
			expectedSlug: ticket.slug,
			expectedWorkflowId: workflowId,
		});
		const acceptedProtocol = validateExecutorResultSection(replacement, { path: ticket.path });
		if (!acceptedProtocol.accepted || acceptedProtocol.body_sha256 !== acceptedResultMetadata.body_sha256) {
			throw new ResultAcceptanceError("Accepted executor result integration evidence is inconsistent.");
		}
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
			accepted: true,
			integration,
			ticket: await inspectTicketInContext(context, ticketId),
		};
	}, { homeDirectory, lockOptions });
}

export { EXECUTOR_RESULT_FIELDS };
