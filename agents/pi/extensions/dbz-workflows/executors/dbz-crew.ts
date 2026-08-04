import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveWorkflowArtifactContext } from "../../../../../skills/dbz-workflows/lib/artifacts.mjs";
import { claimTicket } from "../../../../../skills/dbz-workflows/lib/claims.mjs";
import { ValidationError } from "../../../../../skills/dbz-workflows/lib/errors.mjs";
import { createExecutorResult } from "../../../../../skills/dbz-workflows/lib/executors/protocol.mjs";
import { assertCleanWorktree, inspectTicketWorktree, listGitWorktrees, resolveLocalBranchCommit, ticketBranchName } from "../../../../../skills/dbz-workflows/lib/git-operations.mjs";
import { applyTicketWorktreePlan, createTicketWorktreePlan } from "../../../../../skills/dbz-workflows/lib/git-plans.mjs";
import { inspectGitProject } from "../../../../../skills/dbz-workflows/lib/git-identity.mjs";
import { applyExecutorResult } from "../../../../../skills/dbz-workflows/lib/results.mjs";
import { planSchedulerWave } from "../../../../../skills/dbz-workflows/lib/scheduler.mjs";
import { isProjectMutatingTicket } from "../../../../../skills/dbz-workflows/lib/schemas/ticket.mjs";
import { inspectTicket, listTickets } from "../../../../../skills/dbz-workflows/lib/tickets.mjs";
import { inspectWorkflow, listWorkflows } from "../../../../../skills/dbz-workflows/lib/workflows.mjs";
import { buildTicketContextPacket, type TicketContextPacket } from "../context.ts";
import { integrateMutatingTicketResult, defaultTicketWorktreePath } from "../sessions.ts";
import { boundedToolText, runQueuedMutation, type FileMutationQueue } from "../tools.ts";
import { assertDialogUI, assertTrustedProject } from "../ui.ts";

export const CREW_COMPLETION_EVENT_CHANNEL = "dbz-crew:completion";
export const DBZ_CREW_EXECUTOR = "dbz-crew";
export const DBZ_CREW_TOOL_NAME = "dbz_workflows_crew_executor";
const CREW_TASK_PREFIX = "dbzw-";
const RESULT_MARKER = "DBZ-WORKFLOWS RESULT:";
const RESULT_FENCE = /DBZ-WORKFLOWS RESULT:\s*```json\s*([\s\S]*?)\s*```/u;
const TOOL_ACTIONS = ["plan", "dispatch", "resume", "collect", "cancel", "integrate"] as const;

export interface CrewCompletionEvent {
	id: string;
	principal_session_id: string;
	task_id: string;
	phase: "implementation" | "rebase";
	status: "done" | "blocked" | "failed";
	result: string;
	created_at: number;
	message?: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

type CrewCommandRunner = (
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface DbzCrewDependencies {
	inspectGitProject: typeof inspectGitProject;
	resolveWorkflowArtifactContext: typeof resolveWorkflowArtifactContext;
	inspectWorkflow: typeof inspectWorkflow;
	listWorkflows: typeof listWorkflows;
	inspectTicket: typeof inspectTicket;
	listTickets: typeof listTickets;
	planSchedulerWave: typeof planSchedulerWave;
	claimTicket: typeof claimTicket;
	buildTicketContextPacket: typeof buildTicketContextPacket;
	applyExecutorResult: typeof applyExecutorResult;
	createExecutorResult: typeof createExecutorResult;
	assertCleanWorktree: typeof assertCleanWorktree;
	listGitWorktrees: typeof listGitWorktrees;
	inspectTicketWorktree: typeof inspectTicketWorktree;
	resolveLocalBranchCommit: typeof resolveLocalBranchCommit;
	createTicketWorktreePlan: typeof createTicketWorktreePlan;
	applyTicketWorktreePlan: typeof applyTicketWorktreePlan;
	integrateMutatingTicketResult: typeof integrateMutatingTicketResult;
	readCrewResult: typeof readCrewResult;
	randomId: () => string;
}

const DEFAULT_DEPENDENCIES: DbzCrewDependencies = {
	inspectGitProject,
	resolveWorkflowArtifactContext,
	inspectWorkflow,
	listWorkflows,
	inspectTicket,
	listTickets,
	planSchedulerWave,
	claimTicket,
	buildTicketContextPacket,
	applyExecutorResult,
	createExecutorResult,
	assertCleanWorktree,
	listGitWorktrees,
	inspectTicketWorktree,
	resolveLocalBranchCommit,
	createTicketWorktreePlan,
	applyTicketWorktreePlan,
	integrateMutatingTicketResult,
	readCrewResult,
	randomId: randomUUID,
};

interface PreparedTarget {
	cwd: string;
	mutates_project: boolean;
	branch: string | null;
	worktree: string | null;
	worktree_plan: any | null;
}

interface PreparedDispatch {
	workflow: any;
	storage_mode: string;
	wave: any;
	entries: Array<{
		ticket: any;
		task_id: string;
		target: PreparedTarget;
		packet: TicketContextPacket;
	}>;
}

interface ClaimedDispatchEntry {
	ticket: any;
	task_id: string;
	target: PreparedTarget;
	packet: TicketContextPacket;
	claim: any;
}

interface CrewRuntimeIdentity {
	principal_session_id: string;
	provider?: string;
	model?: string;
	thinking?: string;
}

export interface DbzCrewRegistrationOptions {
	cliPath?: string;
	homeDirectory?: string;
	stateRoot?: string;
	dependencies?: Partial<DbzCrewDependencies>;
	fileMutationQueue?: FileMutationQueue;
	commandRunner?: CrewCommandRunner;
}

export function defaultCrewCliPath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../skills/dbz-crew/scripts/dbz-crew");
}

export function crewAdapterResourceAvailable(cliPath = defaultCrewCliPath()): boolean {
	try {
		const info = lstatSync(cliPath);
		return info.isFile() && !info.isSymbolicLink();
	} catch {
		return false;
	}
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new ValidationError(`${name} must be non-empty text without NUL bytes.`);
	}
	return value.trim();
}

function requiredSingleLine(value: unknown, name: string): string {
	const normalized = requiredString(value, name);
	if (/[\r\n]/u.test(normalized)) throw new ValidationError(`${name} must be a single line.`);
	return normalized;
}

function parseJsonOutput(value: string, label: string): any {
	const start = value.indexOf("{");
	if (start < 0) throw new ValidationError(`${label} did not return JSON.`);
	try {
		return JSON.parse(value.slice(start));
	} catch (error) {
		throw new ValidationError(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function toolResult(operation: string, value: unknown) {
	const bounded = boundedToolText(value);
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: { operation, truncated: bounded.truncated },
	};
}

export function createCrewTaskId(workflowId: string, ticketId: string, nonce = randomUUID()): string {
	const digest = createHash("sha256").update(`${workflowId}\0${ticketId}\0${nonce}`).digest("hex").slice(0, 19);
	return `${CREW_TASK_PREFIX}${digest}`;
}

function nonDoneEvidence(
	outcome: "blocked" | "failed",
	message: string,
	source: string,
): Record<string, string | string[]> {
	const excerpt = source.replace(/\0/gu, "").replace(/[\r\n\t ]+/gu, " ").trim().slice(0, 1200);
	const detail = excerpt ? `${message} Worker output excerpt: ${excerpt}` : message;
	return {
		outcome,
		reason: requiredSingleLine(detail.slice(0, 1800), `${outcome} reason`),
		summary: outcome === "blocked"
			? "The delegated DBZ Crew attempt reported a blocker and did not receive coordinator acceptance."
			: "The delegated DBZ Crew attempt failed and did not receive coordinator acceptance.",
		deliverables: `No deliverable is accepted from this ${outcome} attempt.`,
		acceptance_criteria_evidence: `Acceptance criteria remain unverified because the delegated attempt is ${outcome}.`,
		validation: detail,
		deviations: "The ticket remains incomplete and must be retried or replanned explicitly.",
		follow_ups: "Inspect the retained diagnostics and any preserved ticket worktree before replanning.",
		worker_commits: [],
	};
}

function parsedResultPayload(source: string): any {
	const match = RESULT_FENCE.exec(source);
	if (!match) throw new ValidationError(`Worker output is missing the fenced '${RESULT_MARKER}' JSON object.`);
	const value = JSON.parse(match[1]);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError("Worker result JSON must be a mapping.");
	}
	return value;
}

export function normalizeCrewExecutorResult({
	eventStatus,
	source,
	ticket,
	claim,
	createResult = createExecutorResult,
}: {
	eventStatus: CrewCompletionEvent["status"];
	source: string;
	ticket: any;
	claim: any;
	createResult?: typeof createExecutorResult;
}): ReturnType<typeof createExecutorResult> {
	const base = {
		workflow_id: ticket.metadata.workflow_id,
		ticket_id: ticket.id,
		claim,
	};
	try {
		if (Buffer.byteLength(source, "utf8") > DEFAULT_MAX_BYTES || source.split("\n").length > DEFAULT_MAX_LINES) {
			throw new ValidationError("Worker output exceeds Pi's 50 KB / 2,000-line result limit.");
		}
		if (eventStatus === "failed") {
			return createResult({ ...base, ...nonDoneEvidence("failed", "DBZ Crew reported worker failure.", source) }, {
				requireWorkerCommits: isProjectMutatingTicket(ticket.metadata),
			});
		}
		const payload = parsedResultPayload(source);
		const forcedOutcome = eventStatus === "blocked" ? "blocked" : payload.outcome;
		if (eventStatus === "blocked" && forcedOutcome === "blocked" && !payload.reason) {
			payload.reason = "DBZ Crew reported that the worker is blocked.";
		}
		return createResult({
			...base,
			...payload,
			outcome: forcedOutcome,
			worker_commits: payload.worker_commits ?? [],
		}, { requireWorkerCommits: isProjectMutatingTicket(ticket.metadata) });
	} catch (error) {
		const message = `DBZ Crew result normalization failed: ${error instanceof Error ? error.message : String(error)}`;
		const outcome = eventStatus === "blocked" ? "blocked" : "failed";
		return createResult({ ...base, ...nonDoneEvidence(outcome, message, source) }, {
			requireWorkerCommits: isProjectMutatingTicket(ticket.metadata),
		});
	}
}

export function buildCrewExecutionPrompt(packet: TicketContextPacket): string {
	const content = packet.content
		.replace(
			/Submit exactly one normalized `done`, `blocked`, or `failed` result[^\n]*/u,
			"Do not call DBZ Workflows commands or mutation tools. Return the normalized result only through the DBZ Crew protocol below; the coordinator alone mutates canonical workflow state.",
		)
		.replace(
			/The Ticket block is the reviewed pre-claim snapshot[^\n]*/u,
			"The Ticket block is the reviewed execution input. The coordinator owns the durable claim and all canonical state transitions.",
		);
	return [
		content.trimEnd(),
		"",
		"## DBZ Crew Result Protocol",
		"",
		"Finish with exactly one fenced JSON result followed by the DBZ Crew marker. Keep every evidence field free of level-one through level-three Markdown headings.",
		"",
		RESULT_MARKER,
		"```json",
		JSON.stringify({
			outcome: "done | blocked | failed",
			reason: "required single-line reason for blocked or failed; omit for done",
			summary: "non-empty Markdown evidence",
			deliverables: "non-empty Markdown evidence",
			acceptance_criteria_evidence: "non-empty Markdown evidence",
			validation: "non-empty Markdown evidence",
			deviations: "non-empty Markdown evidence",
			follow_ups: "non-empty Markdown evidence",
			worker_commits: ["full lowercase commit IDs for a done mutating ticket; otherwise empty"],
		}, null, 2),
		"```",
		"DBZ-CREW RESULT: <done | blocked | failed>",
		"",
	].join("\n");
}

export async function readCrewResult(
	path: string,
	{ stateRoot = resolve(userInfo().homedir, ".local", "state", "dbz-crew") }: { stateRoot?: string } = {},
): Promise<string> {
	const normalized = resolve(requiredString(path, "DBZ Crew result path"));
	if (!isAbsolute(path) || normalized !== path) throw new ValidationError("DBZ Crew result path must be normalized and absolute.");
	const resultsRoot = resolve(stateRoot, "results");
	const inside = relative(resultsRoot, normalized);
	if (inside.startsWith("..") || isAbsolute(inside)) throw new ValidationError("DBZ Crew result path is outside its private results directory.");
	if (typeof fsConstants.O_NOFOLLOW !== "number") throw new ValidationError("Secure DBZ Crew result reading requires O_NOFOLLOW.");
	const handle = await open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const stats = await handle.stat();
		const uid = process.getuid?.();
		if (!stats.isFile() || uid === undefined || stats.uid !== uid) {
			throw new ValidationError("DBZ Crew result must be a current-user regular file.");
		}
		if (stats.size > DEFAULT_MAX_BYTES) throw new ValidationError("DBZ Crew result exceeds Pi's 50 KB output limit.");
		const source = await handle.readFile("utf8");
		if (source.split("\n").length > DEFAULT_MAX_LINES) throw new ValidationError("DBZ Crew result exceeds Pi's 2,000-line output limit.");
		return source;
	} finally {
		await handle.close();
	}
}

function assertCoordinatorContext(ctx: ExtensionContext): void {
	assertTrustedProject(ctx);
	if (process.env.DBZ_WORKFLOWS_EXECUTOR === DBZ_CREW_EXECUTOR) {
		throw new ValidationError("A delegated DBZ Crew worker cannot coordinate or dispatch DBZ Workflows tickets.");
	}
}

async function identityFor(ctx: ExtensionContext, deps: DbzCrewDependencies): Promise<any> {
	assertCoordinatorContext(ctx);
	return deps.inspectGitProject(ctx.cwd);
}

async function prepareTarget(
	identity: any,
	workflow: any,
	ticket: any,
	deps: DbzCrewDependencies,
): Promise<PreparedTarget> {
	if (!isProjectMutatingTicket(ticket.metadata)) {
		return { cwd: identity.projectRoot, mutates_project: false, branch: null, worktree: null, worktree_plan: null };
	}
	const branch = ticketBranchName(workflow.id, ticket.id, ticket.slug);
	const worktree = defaultTicketWorktreePath(identity.projectRoot, workflow.id, ticket.id, ticket.slug);
	const registered = (await deps.listGitWorktrees(identity.projectRoot)).find(({ path }: any) => resolve(path) === worktree);
	if (registered !== undefined) {
		const inspected = await deps.inspectTicketWorktree(identity.projectRoot, worktree, { expectedBranch: branch });
		if (!inspected.status.clean) throw new ValidationError(`Ticket worktree '${worktree}' must be clean before DBZ Crew dispatch.`);
		return { cwd: worktree, mutates_project: true, branch, worktree, worktree_plan: null };
	}
	const existing = await deps.resolveLocalBranchCommit(identity.projectRoot, branch);
	const plan = await deps.createTicketWorktreePlan({
		cwd: identity.projectRoot,
		worktreePath: worktree,
		workflowId: workflow.id,
		workflowSlug: workflow.slug,
		ticketId: ticket.id,
		ticketSlug: ticket.slug,
		...(existing === null ? {} : { adoptExistingCommit: existing }),
	});
	return { cwd: worktree, mutates_project: true, branch, worktree, worktree_plan: plan };
}

async function prepareDispatch(
	identity: any,
	workflowId: string,
	options: { ticketIds?: string[]; maxConcurrency?: number; contextWindowTokens?: number; homeDirectory?: string },
	deps: DbzCrewDependencies,
): Promise<PreparedDispatch> {
	const [context, workflow, wave] = await Promise.all([
		deps.resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory: options.homeDirectory }),
		deps.inspectWorkflow(identity, workflowId, { homeDirectory: options.homeDirectory }),
		deps.planSchedulerWave(identity, workflowId, {
			homeDirectory: options.homeDirectory,
			executor: "delegated",
			requestedTicketIds: options.ticketIds,
			maxConcurrency: options.maxConcurrency,
			contextWindowTokens: options.contextWindowTokens,
		}),
	]);
	const tickets = await deps.listTickets(identity, workflowId, { homeDirectory: options.homeDirectory });
	const selected = wave.ticket_ids.map((id: string) => {
		const ticket = tickets.find((candidate: any) => candidate.id === id);
		if (!ticket) throw new ValidationError(`Planned ticket '${id}' disappeared before DBZ Crew dispatch preparation.`);
		if (ticket.type === "question-session") throw new ValidationError("Question-session tickets are interactive-only and cannot be dispatched to DBZ Crew.");
		return ticket;
	});
	if (selected.length === 0) throw new ValidationError("No delegated ticket is actionable for this DBZ Crew wave.");
	const status = await deps.assertCleanWorktree(identity.projectRoot);
	if (status.headBranch !== workflow.metadata.git.workflow_branch) {
		throw new ValidationError(`DBZ Crew dispatch requires clean checked-out workflow branch '${workflow.metadata.git.workflow_branch}'.`);
	}
	const entries = [];
	for (const ticket of selected) {
		const target = await prepareTarget(identity, workflow, ticket, deps);
		const packet = await deps.buildTicketContextPacket(identity, workflowId, ticket.id, {
			homeDirectory: options.homeDirectory,
			contextWindowTokens: options.contextWindowTokens,
			executionEnvironment: {
				cwd: target.cwd,
				mutates_project: target.mutates_project,
				branch: target.branch,
				worktree: target.worktree,
			},
		});
		entries.push({ ticket, target, packet, task_id: createCrewTaskId(workflowId, ticket.id, deps.randomId()) });
	}
	return { workflow, storage_mode: context.storage.mode, wave, entries };
}

function dispatchPreview(prepared: PreparedDispatch): string {
	return [
		`Workflow: ${prepared.workflow.id} — ${prepared.workflow.title}`,
		`Executor: ${DBZ_CREW_EXECUTOR}`,
		`Confirmed concurrency limit: ${prepared.wave.max_concurrency}`,
		`Parallel workers: ${prepared.entries.length}`,
		`Storage mode: ${prepared.storage_mode}`,
		"",
		"Tickets and execution targets:",
		...prepared.entries.map(({ ticket, task_id, target }) => [
			`- ${ticket.id} (${ticket.type}) → ${task_id}`,
			`  cwd: ${target.cwd}`,
			`  branch: ${target.branch ?? "temporary read-only Crew snapshot"}`,
		].join("\n")),
		"",
		"Reviewed scheduler wave:",
		JSON.stringify(prepared.wave, null, 2),
		"",
		"Reviewed ticket-worktree plans:",
		...prepared.entries.filter(({ target }) => target.worktree_plan !== null).map(({ target }) => JSON.stringify(target.worktree_plan, null, 2)),
		"",
		"Workers return results only. The coordinator applies canonical result state and separately confirms reconciliation, integration, and cleanup.",
	].join("\n");
}

async function applyPreparedTargets(prepared: PreparedDispatch, deps: DbzCrewDependencies): Promise<void> {
	for (const { target } of prepared.entries) {
		if (target.worktree_plan === null) continue;
		await deps.applyTicketWorktreePlan(target.worktree_plan, {
			authorization: { confirmed: true, planDigest: target.worktree_plan.plan_digest },
		});
	}
}

async function claimPreparedEntries(
	identity: any,
	prepared: PreparedDispatch,
	options: { homeDirectory?: string; contextWindowTokens?: number },
	deps: DbzCrewDependencies,
	queue: FileMutationQueue,
): Promise<ClaimedDispatchEntry[]> {
	const claimed = [];
	for (const entry of prepared.entries) {
		try {
			const result = await runQueuedMutation([entry.ticket.path], () => deps.claimTicket(
				identity,
				prepared.workflow.id,
				entry.ticket.id,
				{
					expectedTicketDigest: entry.ticket.digest,
					executor: DBZ_CREW_EXECUTOR,
					sessionId: entry.task_id,
					homeDirectory: options.homeDirectory,
					contextWindowTokens: options.contextWindowTokens,
				},
			), queue);
			claimed.push({ ...entry, ticket: result.ticket, claim: result.claim });
		} catch (error) {
			const retained = claimed.map(({ ticket, task_id }) => `${ticket.id} (${task_id})`).join(", ");
			throw new ValidationError(
				`DBZ Crew claim creation failed for '${entry.ticket.id}': ${error instanceof Error ? error.message : String(error)}.` +
				(retained ? ` Earlier durable claims remain undispatched and never expire automatically: ${retained}. Resume or recover them explicitly.` : " No Crew worker was dispatched for this ticket."),
				{ cause: error },
			);
		}
	}
	return claimed;
}

function crewDispatchArguments(
	entry: ClaimedDispatchEntry,
	workflow: any,
	parallel: boolean,
	runtime: CrewRuntimeIdentity,
): string[] {
	const args = [
		"dispatch",
		"--workflow-adapter",
		"--principal-session-id", runtime.principal_session_id,
		"--task-id", entry.task_id,
		"--prompt", buildCrewExecutionPrompt(entry.packet),
	];
	if (runtime.provider) args.push("--worker-provider", runtime.provider);
	if (runtime.model) args.push("--worker-model", runtime.model);
	if (runtime.thinking) args.push("--worker-thinking", runtime.thinking);
	if (entry.target.mutates_project) {
		args.push("--existing-worktree", requiredString(entry.target.worktree, "ticket worktree"));
		args.push("--expected-branch", requiredString(entry.target.branch, "ticket branch"));
	} else {
		args.push("--read-only", "--committed-only", "--base", workflow.metadata.git.workflow_branch);
	}
	if (parallel) args.push("--parallel");
	return args;
}

async function applyDispatchFailure(
	identity: any,
	workflowId: string,
	entry: ClaimedDispatchEntry,
	diagnostic: string,
	options: { homeDirectory?: string },
	deps: DbzCrewDependencies,
	queue: FileMutationQueue,
): Promise<any> {
	const result = normalizeCrewExecutorResult({
		eventStatus: "failed",
		source: diagnostic,
		ticket: entry.ticket,
		claim: entry.claim,
		createResult: deps.createExecutorResult,
	});
	return runQueuedMutation([entry.ticket.path], () => deps.applyExecutorResult(
		identity,
		workflowId,
		entry.ticket.id,
		result,
		{
			expectedTicketDigest: entry.ticket.digest,
			failedDisposition: "open",
			homeDirectory: options.homeDirectory,
		},
	), queue);
}

async function dispatchClaimedEntries(
	identity: any,
	workflow: any,
	entries: ClaimedDispatchEntry[],
	runCrew: CrewCommandRunner,
	options: { homeDirectory?: string; signal?: AbortSignal; runtime: CrewRuntimeIdentity },
	deps: DbzCrewDependencies,
	queue: FileMutationQueue,
): Promise<any[]> {
	const results = [];
	const parallel = entries.length > 1;
	for (const entry of entries) {
		let command: CommandResult;
		try {
			command = await runCrew(crewDispatchArguments(entry, workflow, parallel, options.runtime), {
				cwd: identity.projectRoot,
				signal: options.signal,
			});
		} catch (error) {
			results.push({
				ticket_id: entry.ticket.id,
				task_id: entry.task_id,
				dispatched: false,
				claim_retained: true,
				diagnostic: `DBZ Crew dispatch invocation failed before its launch state could be verified: ${error instanceof Error ? error.message : String(error)}. Use collect, cancel, or explicit claim recovery; the claim was not released.`,
			});
			continue;
		}
		if (command.code === 0) {
			try {
				results.push({ ticket_id: entry.ticket.id, task_id: entry.task_id, dispatched: true, crew: parseJsonOutput(command.stdout, "DBZ Crew dispatch") });
			} catch (error) {
				results.push({
					ticket_id: entry.ticket.id,
					task_id: entry.task_id,
					dispatched: true,
					claim_retained: true,
					diagnostic: `DBZ Crew reported successful dispatch with malformed metadata: ${error instanceof Error ? error.message : String(error)}. The worker and durable claim may be active; collect or cancel explicitly.`,
				});
			}
			continue;
		}
		const diagnostic = command.stderr.trim() || command.stdout.trim() || "DBZ Crew dispatch failed without output.";
		if (options.signal?.aborted || command.killed) {
			results.push({
				ticket_id: entry.ticket.id,
				task_id: entry.task_id,
				dispatched: false,
				claim_retained: true,
				diagnostic: `${diagnostic} Dispatch was interrupted, so the durable claim is retained until explicit collect, cancel, or recovery.`,
			});
			continue;
		}
		const applied = await applyDispatchFailure(identity, workflow.id, entry, diagnostic, options, deps, queue);
		results.push({ ticket_id: entry.ticket.id, task_id: entry.task_id, dispatched: false, diagnostic, safe_state: applied.ticket.status });
	}
	return results;
}

async function claimedEntriesForResume(
	identity: any,
	workflowId: string,
	ticketIds: string[],
	options: { homeDirectory?: string; contextWindowTokens?: number },
	deps: DbzCrewDependencies,
): Promise<{ workflow: any; entries: ClaimedDispatchEntry[] }> {
	if (!Array.isArray(ticketIds) || ticketIds.length === 0) throw new ValidationError("Crew resume requires at least one ticket ID.");
	const workflow = await deps.inspectWorkflow(identity, workflowId, { homeDirectory: options.homeDirectory });
	const status = await deps.assertCleanWorktree(identity.projectRoot);
	if (status.headBranch !== workflow.metadata.git.workflow_branch) {
		throw new ValidationError(`Crew resume requires clean checked-out workflow branch '${workflow.metadata.git.workflow_branch}'.`);
	}
	const entries = [];
	for (const ticketId of ticketIds) {
		const ticket = await deps.inspectTicket(identity, workflowId, ticketId, { homeDirectory: options.homeDirectory });
		const claim = ticket.execution?.claim;
		if (ticket.status !== "in-progress" || claim?.executor !== DBZ_CREW_EXECUTOR || ticket.execution?.result !== undefined) {
			throw new ValidationError(`Ticket '${ticketId}' has no resumable undispatched DBZ Crew claim.`);
		}
		const target = await prepareTarget(identity, workflow, ticket, deps);
		if (target.worktree_plan !== null) {
			throw new ValidationError(`Claimed mutating ticket '${ticketId}' is missing its previously reviewed ticket worktree.`);
		}
		const packet = await deps.buildTicketContextPacket(identity, workflowId, ticketId, {
			homeDirectory: options.homeDirectory,
			contextWindowTokens: options.contextWindowTokens,
			executionEnvironment: {
				cwd: target.cwd,
				mutates_project: target.mutates_project,
				branch: target.branch,
				worktree: target.worktree,
			},
		});
		entries.push({ ticket, claim, target, packet, task_id: claim.session_id });
	}
	return { workflow, entries };
}

async function locateCrewTicket(
	identity: any,
	taskId: string,
	homeDirectory: string | undefined,
	deps: DbzCrewDependencies,
): Promise<{ workflow: any; ticket: any } | null> {
	if (!taskId.startsWith(CREW_TASK_PREFIX)) return null;
	const matches = [];
	for (const workflow of await deps.listWorkflows(identity, { homeDirectory })) {
		for (const ticket of await deps.listTickets(identity, workflow.id, { homeDirectory })) {
			const claimSession = ticket.execution?.claim?.session_id;
			const resultSession = ticket.execution?.result?.claim?.session_id;
			if (claimSession === taskId || resultSession === taskId) matches.push({ workflow, ticket });
		}
	}
	if (matches.length > 1) throw new ValidationError(`DBZ Crew task '${taskId}' matches more than one canonical ticket claim.`);
	return matches[0] ?? null;
}

async function collectCompletion(
	ctx: ExtensionContext,
	event: CrewCompletionEvent,
	options: { homeDirectory?: string; stateRoot?: string },
	deps: DbzCrewDependencies,
	queue: FileMutationQueue,
): Promise<any> {
	const currentSessionId = ctx.sessionManager.getSessionId();
	if (event.principal_session_id !== currentSessionId) {
		throw new ValidationError(`DBZ Crew completion '${event.id}' belongs to a different Pi principal session.`);
	}
	if (event.phase !== "implementation") {
		throw new ValidationError(`DBZ Workflows does not accept DBZ Crew '${event.phase}' events; reconciliation is coordinator-owned.`);
	}
	const identity = await identityFor(ctx, deps);
	const located = await locateCrewTicket(identity, requiredSingleLine(event.task_id, "Crew task ID"), options.homeDirectory, deps);
	if (located === null) return { handled: false, reason: "not_a_dbz_workflows_claim" };
	const { workflow, ticket } = located;
	if (ticket.execution?.result?.claim?.session_id === event.task_id) {
		return { handled: true, duplicate: true, workflow_id: workflow.id, ticket_id: ticket.id };
	}
	const claim = ticket.execution?.claim;
	if (ticket.status !== "in-progress" || claim?.executor !== DBZ_CREW_EXECUTOR || claim.session_id !== event.task_id) {
		throw new ValidationError(`Crew completion '${event.task_id}' does not match an active canonical DBZ Crew claim.`);
	}
	let source: string;
	let status = event.status;
	try {
		source = await deps.readCrewResult(event.result, { stateRoot: options.stateRoot });
	} catch (error) {
		status = "failed";
		source = `DBZ Crew result could not be read safely: ${error instanceof Error ? error.message : String(error)}`;
	}
	const normalized = normalizeCrewExecutorResult({
		eventStatus: status,
		source,
		ticket,
		claim,
		createResult: deps.createExecutorResult,
	});
	const applied = await runQueuedMutation([ticket.path], () => deps.applyExecutorResult(
		identity,
		workflow.id,
		ticket.id,
		normalized,
		{
			expectedTicketDigest: ticket.digest,
			...(normalized.outcome === "failed" ? { failedDisposition: "open" } : {}),
			homeDirectory: options.homeDirectory,
		},
	), queue);
	ctx.ui.notify(
		normalized.outcome === "done"
			? `DBZ Crew submitted a done result for ${workflow.id}/${ticket.id}. Review and integrate it from coordination; the worker did not complete the ticket.`
			: `DBZ Crew result for ${workflow.id}/${ticket.id} was normalized as ${normalized.outcome}. Canonical safe state: ${applied.ticket.status}.`,
		normalized.outcome === "done" ? "info" : "warning",
	);
	return {
		handled: true,
		workflow_id: workflow.id,
		ticket_id: ticket.id,
		outcome: normalized.outcome,
		status: applied.ticket.status,
		claim_released: applied.claim_released,
	};
}

function normalizeCompletionEvent(value: unknown): CrewCompletionEvent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("DBZ Crew completion event must be a mapping.");
	const event = value as Record<string, unknown>;
	if (
		typeof event.id !== "string" || !event.id ||
		typeof event.principal_session_id !== "string" || !event.principal_session_id ||
		typeof event.task_id !== "string" || !event.task_id ||
		(event.phase !== "implementation" && event.phase !== "rebase") ||
		(event.status !== "done" && event.status !== "blocked" && event.status !== "failed") ||
		typeof event.result !== "string" || !event.result ||
		typeof event.created_at !== "number" || !Number.isFinite(event.created_at)
	) throw new ValidationError("DBZ Crew completion event is invalid.");
	return event as unknown as CrewCompletionEvent;
}

export function registerDbzCrewExecutor(
	pi: ExtensionAPI,
	options: DbzCrewRegistrationOptions = {},
): boolean {
	const cliPath = resolve(options.cliPath ?? defaultCrewCliPath());
	if (!crewAdapterResourceAvailable(cliPath)) return false;
	const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies } as DbzCrewDependencies;
	const queue = options.fileMutationQueue ?? withFileMutationQueue;
	const runCrew: CrewCommandRunner = options.commandRunner ?? (async (args, commandOptions) => {
		const result = await pi.exec("python3", [cliPath, ...args], commandOptions);
		return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
	});
	let currentContext: ExtensionContext | undefined;
	const pending: CrewCompletionEvent[] = [];

	const processEvent = async (event: CrewCompletionEvent, ctx: ExtensionContext) => {
		try {
			await collectCompletion(ctx, event, options, deps, queue);
		} catch (error) {
			ctx.ui.notify(
				`DBZ Workflows could not apply DBZ Crew completion '${event.task_id}': ${error instanceof Error ? error.message : String(error)}. The durable claim and worker result are retained for explicit collect, cancel, or recovery.`,
				"error",
			);
		}
	};

	pi.events.on(CREW_COMPLETION_EVENT_CHANNEL, (value) => {
		const event = normalizeCompletionEvent(value);
		if (!event.task_id.startsWith(CREW_TASK_PREFIX)) return;
		if (currentContext === undefined) pending.push(event);
		else void processEvent(event, currentContext);
	});
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		for (const event of pending.splice(0)) await processEvent(event, ctx);
	});
	pi.on("session_shutdown", () => {
		currentContext = undefined;
	});

	pi.registerTool({
		name: DBZ_CREW_TOOL_NAME,
		label: "DBZ Workflows Crew Executor",
		description: `${DBZ_CREW_TOOL_NAME} plans, explicitly confirms, dispatches, collects, cancels, or integrates optional DBZ Crew execution without granting workers canonical-write authority. Use ${DBZ_CREW_TOOL_NAME} instead of editing DBZ Workflows managed frontmatter directly; direct managed-frontmatter edits are prohibited. Output is bounded to Pi's 50 KB / 2,000-line limits.`,
		promptGuidelines: [
			`Use ${DBZ_CREW_TOOL_NAME} only after the user explicitly requests DBZ Crew delegation or confirms the displayed wave; never infer dispatch from status or planning.`,
			`Use ${DBZ_CREW_TOOL_NAME} for its guarded canonical mutations and never edit DBZ Workflows managed frontmatter directly.`,
		],
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(TOOL_ACTIONS),
			workflow_id: Type.String(),
			ticket_ids: Type.Optional(Type.Array(Type.String())),
			max_concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const identity = await identityFor(ctx, deps);
			const common = {
				homeDirectory: options.homeDirectory,
				contextWindowTokens: ctx.model?.contextWindow,
			};
			const runtime: CrewRuntimeIdentity = {
				principal_session_id: requiredSingleLine(ctx.sessionManager.getSessionId(), "principal Pi session ID"),
				...(typeof ctx.model?.provider === "string" ? { provider: ctx.model.provider } : {}),
				...(typeof ctx.model?.id === "string" ? { model: ctx.model.id } : {}),
				...(typeof ctx.thinkingLevel === "string" ? { thinking: ctx.thinkingLevel } : {}),
			};
			if (params.action === "plan") {
				return toolResult("crew_plan", await deps.planSchedulerWave(identity, params.workflow_id, {
					...common,
					executor: "delegated",
					requestedTicketIds: params.ticket_ids,
					maxConcurrency: params.max_concurrency,
				}));
			}
			assertDialogUI(ctx, `DBZ Crew ${params.action}`);
			if (params.action === "dispatch") {
				const preflight = await runCrew([
					"preflight",
					"--workflow-adapter",
					"--principal-session-id", runtime.principal_session_id,
				], { cwd: identity.projectRoot, signal });
				if (preflight.code !== 0 || parseJsonOutput(preflight.stdout, "DBZ Crew preflight").ok !== true) {
					throw new ValidationError(preflight.stderr.trim() || preflight.stdout.trim() || "DBZ Crew workflow-adapter preflight failed.");
				}
				const prepared = await prepareDispatch(identity, params.workflow_id, {
					...common,
					ticketIds: params.ticket_ids,
					maxConcurrency: params.max_concurrency,
				}, deps);
				const confirmed = await ctx.ui.confirm("Dispatch this DBZ Crew wave?", dispatchPreview(prepared));
				if (!confirmed) return toolResult("crew_dispatch", { dispatched: false, cancelled: true, claims_created: false });
				await applyPreparedTargets(prepared, deps);
				const claimed = await claimPreparedEntries(identity, prepared, common, deps, queue);
				if (prepared.storage_mode === "project") {
					try {
						await deps.assertCleanWorktree(identity.projectRoot);
					} catch {
						return toolResult("crew_dispatch", {
							dispatched: false,
							action: "canonical_commit_required",
							claims: claimed.map(({ ticket, task_id }) => ({ ticket_id: ticket.id, task_id })),
							message: "Project-local canonical claim changes must be committed or otherwise leave the workflow checkout clean. Then call the resume action for these exact ticket IDs. Claims never expire automatically.",
						});
					}
				}
				return toolResult("crew_dispatch", {
					dispatched: true,
					results: await dispatchClaimedEntries(identity, prepared.workflow, claimed, runCrew, {
						homeDirectory: options.homeDirectory,
						signal,
						runtime,
					}, deps, queue),
				});
			}
			if (params.action === "resume") {
				const resumable = await claimedEntriesForResume(identity, params.workflow_id, params.ticket_ids ?? [], common, deps);
				const confirmed = await ctx.ui.confirm(
					"Dispatch the retained DBZ Crew claims?",
					resumable.entries.map(({ ticket, task_id, target }) => `${ticket.id} → ${task_id}\n  cwd: ${target.cwd}`).join("\n"),
				);
				if (!confirmed) return toolResult("crew_resume", { dispatched: false, cancelled: true, claims_retained: true });
				return toolResult("crew_resume", {
					dispatched: true,
					results: await dispatchClaimedEntries(identity, resumable.workflow, resumable.entries, runCrew, {
						homeDirectory: options.homeDirectory,
						signal,
						runtime,
					}, deps, queue),
				});
			}
			const [ticketId, ...extra] = params.ticket_ids ?? [];
			if (!ticketId || extra.length > 0) throw new ValidationError(`Crew ${params.action} requires exactly one ticket ID.`);
			const ticket = await deps.inspectTicket(identity, params.workflow_id, ticketId, { homeDirectory: options.homeDirectory });
			const taskId = ticket.execution?.claim?.session_id ?? ticket.execution?.result?.claim?.session_id;
			if (ticket.execution?.claim?.executor !== DBZ_CREW_EXECUTOR && ticket.execution?.result?.claim?.executor !== DBZ_CREW_EXECUTOR) {
				throw new ValidationError(`Ticket '${ticketId}' is not owned by the DBZ Crew executor.`);
			}
			if (params.action === "collect") {
				const status = await runCrew(["status"], { cwd: identity.projectRoot, signal });
				if (status.code !== 0) throw new ValidationError(status.stderr.trim() || "DBZ Crew status failed.");
				const worker = parseJsonOutput(status.stdout, "DBZ Crew status").workers?.[taskId];
				if (!worker || !["done", "blocked", "failed"].includes(worker.status) || typeof worker.result !== "string") {
					throw new ValidationError(`DBZ Crew task '${taskId}' has no collectable terminal result.`);
				}
				return toolResult("crew_collect", await collectCompletion(ctx, {
					id: `manual-${taskId}`,
					principal_session_id: ctx.sessionManager.getSessionId(),
					task_id: taskId,
					phase: "implementation",
					status: worker.status,
					result: worker.result,
					created_at: Date.now(),
				}, options, deps, queue));
			}
			if (params.action === "cancel") {
				const reason = requiredSingleLine(params.reason, "cancellation reason");
				const confirmed = await ctx.ui.confirm(
					`Cancel DBZ Crew worker for ${params.workflow_id}/${ticketId}?`,
					`Task: ${taskId}\nReason: ${reason}\nThe worker tab will close. The ticket branch/worktree is preserved, and a failed executor result returns the ticket to a safe non-completed state.`,
				);
				if (!confirmed) return toolResult("crew_cancel", { cancelled: false, claim_retained: true });
				const cancelled = await runCrew(["cancel", "--task-id", taskId, "--reason", reason], { cwd: identity.projectRoot, signal });
				if (cancelled.code !== 0) throw new ValidationError(cancelled.stderr.trim() || cancelled.stdout.trim() || "DBZ Crew cancellation failed; the claim is retained.");
				const payload = parseJsonOutput(cancelled.stdout, "DBZ Crew cancellation");
				return toolResult("crew_cancel", await collectCompletion(ctx, {
					id: `cancel-${taskId}`,
					principal_session_id: ctx.sessionManager.getSessionId(),
					task_id: taskId,
					phase: "implementation",
					status: "failed",
					result: payload.result,
					created_at: Date.now(),
				}, options, deps, queue));
			}
			if (!isProjectMutatingTicket(ticket.metadata) || ticket.execution?.result?.outcome !== "done") {
				throw new ValidationError(`Ticket '${ticketId}' has no done mutating DBZ Crew result to integrate.`);
			}
			const releaseConfirmed = await ctx.ui.confirm(
				`Release completed DBZ Crew worker ${taskId}?`,
				"The worker tab will close while its DBZ Workflows-owned ticket branch and worktree are preserved for separately reviewed reconciliation, integration, and cleanup plans.",
			);
			if (!releaseConfirmed) return toolResult("crew_integrate", { integrated: false, worker_retained: true });
			const released = await runCrew(["release", "--task-id", taskId], { cwd: identity.projectRoot, signal });
			if (released.code !== 0) throw new ValidationError(released.stderr.trim() || released.stdout.trim() || "DBZ Crew worker release failed; Git integration was not attempted.");
			const workflow = await deps.inspectWorkflow(identity, params.workflow_id, { homeDirectory: options.homeDirectory });
			return toolResult("crew_integrate", await deps.integrateMutatingTicketResult(ctx as any, identity, workflow, ticket));
		},
	});
	return true;
}
