import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	SessionManager,
	type ExtensionCommandContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { recoverTicketClaim } from "../../../../skills/dbz-workflows/lib/claims.mjs";
import {
	GitStateError,
	ValidationError,
} from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { startManualExecution } from "../../../../skills/dbz-workflows/lib/executors/manual.mjs";
import {
	atomicWriteFile,
	sha256Hex,
} from "../../../../skills/dbz-workflows/lib/filesystem.mjs";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import {
	assertCleanWorktree,
	discoverIntegratedTicketCommits,
	inspectTicketWorktree,
	isCommitAncestor,
	listGitWorktrees,
	resolveLocalBranchCommit,
	ticketBranchName,
} from "../../../../skills/dbz-workflows/lib/git-operations.mjs";
import {
	applyTicketIntegrationPlan,
	applyTicketReconciliationPlan,
	applyTicketWorktreePlan,
	applyTicketWorktreeRemovalPlan,
	createTicketIntegrationPlan,
	createTicketReconciliationPlan,
	createTicketWorktreePlan,
	createTicketWorktreeRemovalPlan,
} from "../../../../skills/dbz-workflows/lib/git-plans.mjs";
import { isProjectMutatingTicket } from "../../../../skills/dbz-workflows/lib/schemas/ticket.mjs";
import { inspectTicket } from "../../../../skills/dbz-workflows/lib/tickets.mjs";
import { inspectWorkflow } from "../../../../skills/dbz-workflows/lib/workflows.mjs";
import {
	buildTicketContextPacket,
	type TicketContextPacket,
	type TicketExecutionEnvironment,
} from "./context.ts";
import {
	assertResultReadyForCoordination,
	coordinatorHandoffPrompt,
} from "./results.ts";

export const TICKET_SESSION_LOCATOR_ENTRY = "dbz-workflows-ticket-session";
export const TICKET_SESSION_LOCATOR_VERSION = 1;
export const COORDINATION_SESSION_LOCATOR_ENTRY = "dbz-workflows-coordination-session";

type SessionLister = (cwd: string, sessionDir?: string) => Promise<SessionInfo[]>;
type SessionCreator = (cwd: string, sessionDir?: string) => SessionManager;
type SessionOpener = (path: string) => SessionManager;

export interface TicketSessionDependencies {
	buildTicketContextPacket: typeof buildTicketContextPacket;
	inspectGitProject: typeof inspectGitProject;
	inspectWorkflow: typeof inspectWorkflow;
	inspectTicket: typeof inspectTicket;
	startManualExecution: typeof startManualExecution;
	recoverTicketClaim: typeof recoverTicketClaim;
	listSessions: SessionLister;
	createSession: SessionCreator;
	openSession: SessionOpener;
	assertCleanWorktree: typeof assertCleanWorktree;
	listGitWorktrees: typeof listGitWorktrees;
	inspectTicketWorktree: typeof inspectTicketWorktree;
	isCommitAncestor: typeof isCommitAncestor;
	discoverIntegratedTicketCommits: typeof discoverIntegratedTicketCommits;
	resolveLocalBranchCommit: typeof resolveLocalBranchCommit;
	createTicketWorktreePlan: typeof createTicketWorktreePlan;
	applyTicketWorktreePlan: typeof applyTicketWorktreePlan;
	createTicketReconciliationPlan: typeof createTicketReconciliationPlan;
	applyTicketReconciliationPlan: typeof applyTicketReconciliationPlan;
	createTicketIntegrationPlan: typeof createTicketIntegrationPlan;
	applyTicketIntegrationPlan: typeof applyTicketIntegrationPlan;
	createTicketWorktreeRemovalPlan: typeof createTicketWorktreeRemovalPlan;
	applyTicketWorktreeRemovalPlan: typeof applyTicketWorktreeRemovalPlan;
}

const DEFAULT_DEPENDENCIES: TicketSessionDependencies = {
	buildTicketContextPacket,
	inspectGitProject,
	inspectWorkflow,
	inspectTicket,
	startManualExecution,
	recoverTicketClaim,
	listSessions: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
	createSession: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
	openSession: (path) => SessionManager.open(path),
	assertCleanWorktree,
	listGitWorktrees,
	inspectTicketWorktree,
	isCommitAncestor,
	discoverIntegratedTicketCommits,
	resolveLocalBranchCommit,
	createTicketWorktreePlan,
	applyTicketWorktreePlan,
	createTicketReconciliationPlan,
	applyTicketReconciliationPlan,
	createTicketIntegrationPlan,
	applyTicketIntegrationPlan,
	createTicketWorktreeRemovalPlan,
	applyTicketWorktreeRemovalPlan,
};

export interface TicketSessionLocator {
	version: 1;
	project_key: string;
	workflow_id: string;
	workflow_slug: string;
	ticket_id: string;
	ticket_slug: string;
	claim_id: string;
	executor_session_id: string;
	executor_cwd: string;
	mutates_project: boolean;
	ticket_branch: string | null;
	ticket_worktree: string | null;
	coordinator_session_id: string;
	coordinator_session_file: string;
	coordinator_cwd: string;
}

interface TicketExecutionTarget extends TicketExecutionEnvironment {
	newly_applied: boolean;
}

function singleLine(value: unknown, name: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError(`${name} must be a non-empty single-line string.`);
	}
	return value.trim();
}

function absolutePath(value: unknown, name: string): string {
	const path = singleLine(value, name);
	if (!path.startsWith("/") || resolve(path) !== path) {
		throw new ValidationError(`${name} must be a normalized absolute path.`);
	}
	return path;
}

function nullableSingleLine(value: unknown, name: string): string | null {
	return value === null ? null : singleLine(value, name);
}

function nullableAbsolutePath(value: unknown, name: string): string | null {
	return value === null ? null : absolutePath(value, name);
}

type SessionManagerView = ExtensionCommandContext["sessionManager"];

function sessionDirectory(manager: SessionManagerView): string | undefined {
	const value = manager.getSessionDir();
	return typeof value === "string" && value.length > 0 ? resolve(value) : undefined;
}

function targetSessionDirectory(
	manager: SessionManagerView,
	_currentCwd: string,
	_targetCwd: string,
): string | undefined {
	// Pi's extension API exposes the active session directory, but not whether it
	// came from --session-dir. Reuse that exact directory and rely on the target
	// session header cwd so cross-cwd switching remains deterministic.
	return sessionDirectory(manager);
}

export function normalizeTicketSessionLocator(value: unknown): TicketSessionLocator {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError("Ticket session locator must be a mapping.");
	}
	const locator = value as Record<string, unknown>;
	if (locator.version !== TICKET_SESSION_LOCATOR_VERSION) {
		throw new ValidationError(`Ticket session locator version must be ${TICKET_SESSION_LOCATOR_VERSION}.`);
	}
	if (typeof locator.mutates_project !== "boolean") {
		throw new ValidationError("Ticket session locator mutates_project must be a boolean.");
	}
	const normalized: TicketSessionLocator = {
		version: 1,
		project_key: singleLine(locator.project_key, "project_key"),
		workflow_id: singleLine(locator.workflow_id, "workflow_id"),
		workflow_slug: singleLine(locator.workflow_slug, "workflow_slug"),
		ticket_id: singleLine(locator.ticket_id, "ticket_id"),
		ticket_slug: singleLine(locator.ticket_slug, "ticket_slug"),
		claim_id: singleLine(locator.claim_id, "claim_id"),
		executor_session_id: singleLine(locator.executor_session_id, "executor_session_id"),
		executor_cwd: absolutePath(locator.executor_cwd, "executor_cwd"),
		mutates_project: locator.mutates_project,
		ticket_branch: nullableSingleLine(locator.ticket_branch, "ticket_branch"),
		ticket_worktree: nullableAbsolutePath(locator.ticket_worktree, "ticket_worktree"),
		coordinator_session_id: singleLine(locator.coordinator_session_id, "coordinator_session_id"),
		coordinator_session_file: absolutePath(locator.coordinator_session_file, "coordinator_session_file"),
		coordinator_cwd: absolutePath(locator.coordinator_cwd, "coordinator_cwd"),
	};
	if (normalized.mutates_project) {
		if (normalized.ticket_branch === null || normalized.ticket_worktree === null) {
			throw new ValidationError("A mutating ticket-session locator requires its ticket branch and worktree.");
		}
		if (normalized.executor_cwd !== normalized.ticket_worktree) {
			throw new ValidationError("A mutating ticket-session cwd must equal its ticket worktree.");
		}
	} else if (normalized.ticket_branch !== null || normalized.ticket_worktree !== null) {
		throw new ValidationError("A read-only ticket-session locator must not identify a ticket branch or worktree.");
	}
	return normalized;
}

export function currentTicketSessionLocator(manager: SessionManagerView): TicketSessionLocator | null {
	const entries = manager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === TICKET_SESSION_LOCATOR_ENTRY) {
			return normalizeTicketSessionLocator(entry.data);
		}
	}
	return null;
}

export function coordinatorCwdForSession(ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">): string {
	return currentTicketSessionLocator(ctx.sessionManager)?.coordinator_cwd ?? resolve(ctx.cwd);
}

export function findSessionById(
	sessions: SessionInfo[],
	sessionId: string,
	{ expectedPath, expectedCwd }: { expectedPath?: string; expectedCwd?: string } = {},
): SessionInfo | null {
	const matches = sessions.filter(({ id }) => id === sessionId);
	if (matches.length > 1) {
		throw new ValidationError(`Pi session ID '${sessionId}' is ambiguous in the configured session directory.`);
	}
	const match = matches[0];
	if (!match) return null;
	if (expectedPath !== undefined && resolve(match.path) !== resolve(expectedPath)) {
		throw new ValidationError(
			`Pi session '${sessionId}' exists at a different path than the recorded DBZ Workflows locator. Refusing to follow the changed locator silently.`,
		);
	}
	if (expectedCwd !== undefined && resolve(match.cwd) !== resolve(expectedCwd)) {
		throw new ValidationError(
			`Pi session '${sessionId}' has cwd '${match.cwd}', not the recorded DBZ Workflows cwd '${expectedCwd}'.`,
		);
	}
	return match;
}

export function defaultTicketWorktreePath(
	projectRoot: string,
	workflowId: string,
	ticketId: string,
	ticketSlug: string,
): string {
	const root = absolutePath(resolve(projectRoot), "projectRoot");
	ticketBranchName(workflowId, ticketId, ticketSlug);
	const suffix = `${workflowId}-${ticketId}-${ticketSlug}`;
	return resolve(dirname(root), `${basename(root)}.dbz-ticket-${suffix}`);
}

export function formatReviewedGitPlan(plan: unknown): string {
	return `Complete reviewed Git plan:\n${JSON.stringify(plan, null, 2)}`;
}

function planAuthorization(plan: any): { confirmed: true; planDigest: string } {
	return { confirmed: true, planDigest: plan.plan_digest };
}

function coordinatorLocator(ctx: ExtensionCommandContext): {
	session_id: string;
	session_file: string;
	cwd: string;
} {
	const sessionId = singleLine(ctx.sessionManager.getSessionId(), "coordinator Pi session ID");
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (typeof sessionFile !== "string" || !sessionFile.startsWith("/")) {
		throw new ValidationError(
			"Dedicated ticket execution requires a persistent coordination session so the executor can return safely. Restart Pi with session persistence and retry.",
		);
	}
	return { session_id: sessionId, session_file: resolve(sessionFile), cwd: resolve(ctx.cwd) };
}

function serializeSession(manager: SessionManager): string {
	const header = manager.getHeader();
	if (header === null) throw new ValidationError("A fresh Pi session is missing its session header.");
	return `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function materializeFreshSession(manager: SessionManager): Promise<{ path: string; source: string }> {
	const path = manager.getSessionFile();
	if (typeof path !== "string") throw new ValidationError("Dedicated execution requires persistent Pi sessions.");
	const source = serializeSession(manager);
	await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return { path: resolve(path), source };
}

async function appendOwnedFreshSessionEntries(
	manager: SessionManager,
	materialized: { path: string; source: string },
): Promise<void> {
	const current = await readFile(materialized.path, "utf8");
	if (current !== materialized.source) {
		throw new ValidationError("The fresh Pi session changed before its DBZ Workflows locator was recorded.");
	}
	await atomicWriteFile(materialized.path, serializeSession(manager), {
		expectedDigest: sha256Hex(materialized.source),
		root: dirname(materialized.path),
		mode: 0o600,
	});
}

async function removeUnclaimedFreshSession(materialized: { path: string; source: string }): Promise<void> {
	try {
		if (await readFile(materialized.path, "utf8") === materialized.source) await unlink(materialized.path);
	} catch {
		// Cleanup is limited to the exact unclaimed file created by this failed attempt.
	}
}

function dispatchSummary(packet: TicketContextPacket): string {
	const budget = packet.context_budget;
	const environment = packet.execution_environment;
	return [
		`Ticket: ${packet.workflow_id}/${packet.ticket_id}`,
		`Dedicated session: ${packet.session_name}`,
		`Replacement-session cwd: ${environment.cwd}`,
		`Ticket branch: ${environment.branch ?? "none (read-only ticket)"}`,
		`Context estimate: ${budget.estimated_tokens}/${budget.budget_tokens} tokens`,
		`Budget exception: ${budget.exception_applied ? "explicitly approved" : "none"}`,
		`Embedded references: ${packet.artifacts.length - 1}`,
		`Repository file bodies: deferred (${packet.references.files.length} declared path(s))`,
		"A durable manual claim will be bound to a fresh session. No coordinator conversation entries will be copied.",
	].join("\n");
}

async function ensureTicketExecutionTarget(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	deps: TicketSessionDependencies,
): Promise<TicketExecutionTarget | null> {
	if (!isProjectMutatingTicket(ticket.metadata)) {
		return {
			cwd: resolve(identity.projectRoot),
			mutates_project: false,
			branch: null,
			worktree: null,
			newly_applied: false,
		};
	}
	const workflowBranch = workflow.metadata?.git?.workflow_branch;
	const branch = ticketBranchName(workflow.id, ticket.id, ticket.slug);
	const worktree = defaultTicketWorktreePath(identity.projectRoot, workflow.id, ticket.id, ticket.slug);
	const source = await deps.assertCleanWorktree(identity.projectRoot);
	if (source.headBranch !== workflowBranch) {
		throw new GitStateError(
			`Mutating ticket dispatch must run from clean checked-out workflow branch '${workflowBranch}'.`,
			{ details: { expected_branch: workflowBranch, actual_branch: source.headBranch } },
		);
	}
	const registered = (await deps.listGitWorktrees(identity.projectRoot)).find(({ path }) => resolve(path) === worktree);
	if (registered !== undefined) {
		await deps.inspectTicketWorktree(identity.projectRoot, worktree, { expectedBranch: branch });
		return {
			cwd: worktree,
			mutates_project: true,
			branch,
			worktree,
			newly_applied: false,
		};
	}
	const existingCommit = await deps.resolveLocalBranchCommit(identity.projectRoot, branch);
	const plan = await deps.createTicketWorktreePlan({
		cwd: identity.projectRoot,
		worktreePath: worktree,
		workflowId: workflow.id,
		workflowSlug: workflow.slug,
		ticketId: ticket.id,
		ticketSlug: ticket.slug,
		expectedBaseCommit: source.headCommit,
		...(existingCommit === null ? {} : { adoptExistingCommit: existingCommit }),
	});
	const confirmed = await ctx.ui.confirm(
		`Apply ticket worktree plan for ${workflow.id}/${ticket.id}?`,
		formatReviewedGitPlan(plan),
	);
	if (!confirmed) {
		ctx.ui.notify("The complete ticket Git plan was not confirmed; no branch, worktree, claim, or session was created.", "info");
		return null;
	}
	const applied = await deps.applyTicketWorktreePlan(plan, { authorization: planAuthorization(plan) });
	if (resolve(applied.worktree_path) !== worktree || applied.branch !== branch) {
		throw new GitStateError("The applied ticket worktree does not match the reviewed execution target.");
	}
	return {
		cwd: worktree,
		mutates_project: true,
		branch,
		worktree,
		newly_applied: true,
	};
}

async function offerUnclaimedWorktreeCleanup(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	target: TicketExecutionTarget,
	deps: TicketSessionDependencies,
): Promise<void> {
	if (!target.mutates_project || !target.newly_applied || target.worktree === null) return;
	try {
		const plan = await deps.createTicketWorktreeRemovalPlan({
			cwd: identity.projectRoot,
			worktreePath: target.worktree,
			workflowId: workflow.id,
			ticketId: ticket.id,
			ticketSlug: ticket.slug,
			removeBranch: true,
			containedInBranch: workflow.metadata.git.workflow_branch,
		});
		const confirmed = await ctx.ui.confirm(
			`Remove unused ticket worktree for ${workflow.id}/${ticket.id}?`,
			formatReviewedGitPlan(plan),
		);
		if (confirmed) {
			await deps.applyTicketWorktreeRemovalPlan(plan, { authorization: planAuthorization(plan) });
		} else {
			ctx.ui.notify(`The confirmed ticket branch and worktree remain at ${target.worktree}.`, "warning");
		}
	} catch (error) {
		ctx.ui.notify(
			`The unused ticket worktree was preserved because a safe reviewed cleanup plan could not be applied: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

function locatorFor(
	identity: any,
	workflow: any,
	ticket: any,
	target: TicketExecutionTarget,
	coordinator: ReturnType<typeof coordinatorLocator>,
	executorSessionId: string,
	claimId: string,
): TicketSessionLocator {
	return {
		version: 1,
		project_key: identity.projectKey,
		workflow_id: workflow.id,
		workflow_slug: workflow.slug,
		ticket_id: ticket.id,
		ticket_slug: ticket.slug,
		claim_id: claimId,
		executor_session_id: executorSessionId,
		executor_cwd: target.cwd,
		mutates_project: target.mutates_project,
		ticket_branch: target.branch,
		ticket_worktree: target.worktree,
		coordinator_session_id: coordinator.session_id,
		coordinator_session_file: coordinator.session_file,
		coordinator_cwd: coordinator.cwd,
	};
}

async function createDedicatedTicketSession(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	deps: TicketSessionDependencies,
	{
		homeDirectory,
		contextWindowTokens,
		target,
	}: {
		homeDirectory?: string;
		contextWindowTokens?: number;
		target: TicketExecutionTarget;
	},
): Promise<{ handled: true; action: string }> {
	const packet = await deps.buildTicketContextPacket(identity, workflow.id, ticket.id, {
		homeDirectory,
		contextWindowTokens,
		executionEnvironment: {
			cwd: target.cwd,
			mutates_project: target.mutates_project,
			branch: target.branch,
			worktree: target.worktree,
		},
	});
	const coordinator = coordinatorLocator(ctx);
	const confirmed = await ctx.ui.confirm(
		`Start dedicated session for ${workflow.id}/${ticket.id}?`,
		dispatchSummary(packet),
	);
	if (!confirmed) {
		ctx.ui.notify("Ticket dispatch was not confirmed; no claim or session was created.", "info");
		await offerUnclaimedWorktreeCleanup(ctx, identity, workflow, ticket, target, deps);
		return { handled: true, action: "cancelled" };
	}
	await ctx.waitForIdle();
	let materialized: { path: string; source: string } | undefined;
	let claimed = false;
	try {
		const sessionDir = targetSessionDirectory(ctx.sessionManager, ctx.cwd, target.cwd);
		const manager = deps.createSession(target.cwd, sessionDir);
		manager.appendSessionInfo(packet.session_name);
		materialized = await materializeFreshSession(manager);
		const executorSessionId = singleLine(manager.getSessionId(), "executor Pi session ID");
		const execution = await deps.startManualExecution(identity, workflow.id, ticket.id, {
			expectedTicketDigest: packet.ticket_digest,
			sessionId: executorSessionId,
			homeDirectory,
			contextWindowTokens,
		});
		claimed = true;
		manager.appendCustomEntry(
			TICKET_SESSION_LOCATOR_ENTRY,
			locatorFor(identity, workflow, ticket, target, coordinator, executorSessionId, execution.claim.claim_id),
		);
		await appendOwnedFreshSessionEntries(manager, materialized);
	} catch (error) {
		if (!claimed && materialized !== undefined) await removeUnclaimedFreshSession(materialized);
		if (!claimed) await offerUnclaimedWorktreeCleanup(ctx, identity, workflow, ticket, target, deps);
		throw new ValidationError(
			claimed
				? `The ticket claim remains active, but its fresh session could not be finalized: ${error instanceof Error ? error.message : String(error)}. Recover the exact claim explicitly; it was not released automatically.`
				: `The fresh ticket session could not be created before claiming: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const sessionPath = materialized.path;
	if (target.mutates_project) {
		try {
			const source = await deps.assertCleanWorktree(identity.projectRoot);
			if (source.headBranch !== workflow.metadata.git.workflow_branch) {
				throw new GitStateError(`Coordinator checkout left workflow branch '${workflow.metadata.git.workflow_branch}' during dispatch.`);
			}
		} catch (error) {
			ctx.ui.notify(
				`The ticket worktree, fresh session, and durable claim were created, but code execution was not dispatched because the coordinator checkout is no longer clean: ${error instanceof Error ? error.message : String(error)}. In project storage mode, commit or otherwise resolve the canonical claim change on the workflow branch, then run /dbz-workflows run ${ticket.id} to resume. The claim was not released.`,
				"warning",
			);
			return { handled: true, action: "canonical_commit_required" };
		}
	}
	const targetCwd = target.cwd;
	const packetContent = packet.content;
	const switched = await ctx.switchSession(sessionPath, {
		withSession: async (replacementCtx) => {
			if (resolve(replacementCtx.cwd) !== targetCwd) {
				replacementCtx.ui.notify(
					`The claimed replacement session opened with cwd '${replacementCtx.cwd}', not applied ticket cwd '${targetCwd}'. The claim remains active and no packet was injected.`,
					"error",
				);
				return;
			}
			try {
				await replacementCtx.sendUserMessage(packetContent);
			} catch (error) {
				replacementCtx.ui.notify(
					`The ticket is claimed by this fresh session, but its bounded context packet could not be injected: ${error instanceof Error ? error.message : String(error)}. Resume this session explicitly; the claim was not released.`,
					"error",
				);
			}
		},
	});
	if (switched.cancelled) {
		ctx.ui.notify(
			"Ticket-session switching was cancelled by a Pi session guard. The fresh session, ticket worktree if any, and durable claim remain available for explicit resume or recovery.",
			"warning",
		);
		return { handled: true, action: "switch_cancelled" };
	}
	return { handled: true, action: "created" };
}

function assertLocatorMatches(
	locator: TicketSessionLocator,
	identity: any,
	workflow: any,
	ticket: any,
	target: TicketExecutionTarget,
): void {
	const expectedBranch = target.branch;
	if (
		locator.project_key !== identity.projectKey ||
		locator.workflow_id !== workflow.id ||
		locator.workflow_slug !== workflow.slug ||
		locator.ticket_id !== ticket.id ||
		locator.ticket_slug !== ticket.slug ||
		locator.claim_id !== ticket.execution.claim.claim_id ||
		locator.executor_session_id !== ticket.execution.claim.session_id ||
		locator.executor_cwd !== target.cwd ||
		locator.mutates_project !== target.mutates_project ||
		locator.ticket_branch !== expectedBranch ||
		locator.ticket_worktree !== target.worktree ||
		locator.coordinator_cwd !== resolve(identity.projectRoot)
	) {
		throw new ValidationError("The claimed Pi session locator does not match the canonical ticket claim and execution target.");
	}
}

async function claimedExecutionTarget(
	identity: any,
	workflow: any,
	ticket: any,
	deps: TicketSessionDependencies,
): Promise<{ target: TicketExecutionTarget | null; reason?: string }> {
	if (!isProjectMutatingTicket(ticket.metadata)) {
		return {
			target: {
				cwd: resolve(identity.projectRoot),
				mutates_project: false,
				branch: null,
				worktree: null,
				newly_applied: false,
			},
		};
	}
	const branch = ticketBranchName(workflow.id, ticket.id, ticket.slug);
	const worktree = defaultTicketWorktreePath(identity.projectRoot, workflow.id, ticket.id, ticket.slug);
	const registered = (await deps.listGitWorktrees(identity.projectRoot)).find(({ path }) => resolve(path) === worktree);
	if (registered === undefined) {
		return { target: null, reason: `Registered ticket worktree ${worktree} is missing` };
	}
	try {
		await deps.inspectTicketWorktree(identity.projectRoot, worktree, { expectedBranch: branch });
	} catch (error) {
		return { target: null, reason: error instanceof Error ? error.message : String(error) };
	}
	return {
		target: {
			cwd: worktree,
			mutates_project: true,
			branch,
			worktree,
			newly_applied: false,
		},
	};
}

async function recoverMissingExecutorSession(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	deps: TicketSessionDependencies,
	options: {
		homeDirectory?: string;
		contextWindowTokens?: number;
		reason: string;
	},
): Promise<{ handled: true; action: string }> {
	const claim = ticket.execution.claim;
	const rationale = `${options.reason}; claimed Pi session ${claim.session_id} cannot be resumed safely`;
	const confirmed = await ctx.ui.confirm(
		`Recover missing execution claim for ${workflow.id}/${ticket.id}?`,
		[
			`Claim: ${claim.claim_id}`,
			`Session: ${claim.session_id}`,
			`Recorded reason: ${rationale}`,
			"Claims never expire automatically. Confirming explicitly invalidates this exact executor claim, records the recovery, preserves any ticket branch/worktree changes, and returns the ticket to open before a fresh session is offered.",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("The missing execution claim remains active; no recovery was applied.", "warning");
		return { handled: true, action: "recovery_cancelled" };
	}
	const recovered = await deps.recoverTicketClaim(identity, workflow.id, ticket.id, {
		expectedTicketDigest: ticket.digest,
		rationale,
		toStatus: "open",
		authorization: {
			confirmed: true,
			recovered_by: "user",
			claim_id: claim.claim_id,
		},
		homeDirectory: options.homeDirectory,
	});
	const target = await ensureTicketExecutionTarget(ctx, identity, workflow, recovered.ticket, deps);
	if (target === null) return { handled: true, action: "recovered" };
	return createDedicatedTicketSession(ctx, identity, workflow, recovered.ticket, deps, {
		homeDirectory: options.homeDirectory,
		contextWindowTokens: options.contextWindowTokens,
		target,
	});
}

async function cleanupIntegratedTicketWorktree(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	worktree: string,
	deps: TicketSessionDependencies,
): Promise<boolean> {
	try {
		const cleanupPlan = await deps.createTicketWorktreeRemovalPlan({
			cwd: identity.projectRoot,
			worktreePath: worktree,
			workflowId: workflow.id,
			ticketId: ticket.id,
			ticketSlug: ticket.slug,
			removeBranch: true,
			containedInBranch: workflow.metadata.git.workflow_branch,
		});
		const cleanupConfirmed = await ctx.ui.confirm(
			`Clean up integrated ticket worktree for ${workflow.id}/${ticket.id}?`,
			formatReviewedGitPlan(cleanupPlan),
		);
		if (!cleanupConfirmed) {
			ctx.ui.notify(`Integrated ticket worktree and branch were preserved at ${worktree}.`, "warning");
			return false;
		}
		await deps.applyTicketWorktreeRemovalPlan(cleanupPlan, { authorization: planAuthorization(cleanupPlan) });
		return true;
	} catch (error) {
		ctx.ui.notify(
			`Ticket commits were integrated, but safe worktree cleanup could not complete: ${error instanceof Error ? error.message : String(error)}. The worktree and branch were preserved for explicit cleanup.`,
			"warning",
		);
		return false;
	}
}

export async function integrateMutatingTicketResult(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	{
		dependencies,
		worktreePath,
	}: {
		dependencies?: Partial<TicketSessionDependencies>;
		worktreePath?: string;
	} = {},
): Promise<{
	action: "not_mutating" | "not_done" | "integration_cancelled" | "integrated";
	integrated_commits: string[];
	worktree_removed: boolean;
}> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as TicketSessionDependencies;
	if (!isProjectMutatingTicket(ticket.metadata)) {
		return { action: "not_mutating", integrated_commits: [], worktree_removed: false };
	}
	const result = ticket.execution?.result;
	if (ticket.status !== "in-progress" || result?.outcome !== "done" || ticket.execution?.claim === null) {
		return { action: "not_done", integrated_commits: [], worktree_removed: false };
	}
	if (ticket.execution.claim.session_id === ctx.sessionManager.getSessionId()) {
		throw new ValidationError("The executor session cannot integrate or accept its own mutating result.");
	}
	const expectedCoordinator = resolve(identity.projectRoot);
	if (resolve(ctx.cwd) !== expectedCoordinator) {
		throw new ValidationError(`Ticket integration requires coordinator cwd '${expectedCoordinator}', not '${ctx.cwd}'.`);
	}
	const branch = ticketBranchName(workflow.id, ticket.id, ticket.slug);
	const worktree = resolve(worktreePath ?? defaultTicketWorktreePath(identity.projectRoot, workflow.id, ticket.id, ticket.slug));
	await deps.inspectTicketWorktree(identity.projectRoot, worktree, { expectedBranch: branch });
	const [workflowCommit, ticketCommit] = await Promise.all([
		deps.resolveLocalBranchCommit(identity.projectRoot, workflow.metadata.git.workflow_branch),
		deps.resolveLocalBranchCommit(identity.projectRoot, branch),
	]);
	if (
		workflowCommit !== null &&
		ticketCommit !== null &&
		await deps.isCommitAncestor(identity.projectRoot, ticketCommit, workflowCommit)
	) {
		const integrated = await deps.discoverIntegratedTicketCommits(identity.projectRoot, {
			fromCommit: workflow.metadata.git.base_commit,
			integrationRef: workflow.metadata.git.workflow_branch,
			workflowId: workflow.id,
			ticketId: ticket.id,
			requireAny: true,
		});
		return {
			action: "integrated",
			integrated_commits: integrated.commits,
			worktree_removed: await cleanupIntegratedTicketWorktree(ctx, identity, workflow, ticket, worktree, deps),
		};
	}

	const reconciliationPlan = await deps.createTicketReconciliationPlan({
		worktreePath: worktree,
		workflowId: workflow.id,
		workflowSlug: workflow.slug,
		ticketId: ticket.id,
		ticketSlug: ticket.slug,
	});
	const reconciliationConfirmed = await ctx.ui.confirm(
		`Reconcile ${workflow.id}/${ticket.id} with the workflow branch?`,
		formatReviewedGitPlan(reconciliationPlan),
	);
	if (!reconciliationConfirmed) {
		ctx.ui.notify("Ticket reconciliation was not confirmed. The result, claim, branch, and worktree remain unchanged.", "warning");
		return { action: "integration_cancelled", integrated_commits: [], worktree_removed: false };
	}
	await deps.applyTicketReconciliationPlan(reconciliationPlan, {
		authorization: planAuthorization(reconciliationPlan),
	});

	const integrationPlan = await deps.createTicketIntegrationPlan({
		cwd: identity.projectRoot,
		workflowId: workflow.id,
		workflowSlug: workflow.slug,
		ticketId: ticket.id,
		ticketSlug: ticket.slug,
	});
	const integrationConfirmed = await ctx.ui.confirm(
		`Integrate ${workflow.id}/${ticket.id} into the workflow branch?`,
		formatReviewedGitPlan(integrationPlan),
	);
	if (!integrationConfirmed) {
		ctx.ui.notify("Ticket integration was not confirmed. The reconciled ticket branch and active claim remain for explicit retry.", "warning");
		return { action: "integration_cancelled", integrated_commits: [], worktree_removed: false };
	}
	const integration = await deps.applyTicketIntegrationPlan(integrationPlan, {
		authorization: planAuthorization(integrationPlan),
	});

	return {
		action: "integrated",
		integrated_commits: integration.integrated_commits,
		worktree_removed: await cleanupIntegratedTicketWorktree(ctx, identity, workflow, ticket, worktree, deps),
	};
}

export async function runOrResumeTicketSession(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	{
		homeDirectory,
		contextWindowTokens,
		plannedTicketDigest,
		dependencies,
	}: {
		homeDirectory?: string;
		contextWindowTokens?: number;
		plannedTicketDigest?: string;
		dependencies?: Partial<TicketSessionDependencies>;
	} = {},
): Promise<{ handled: true; action: string }> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as TicketSessionDependencies;
	const currentWorkflow = await deps.inspectWorkflow(identity, workflow.id, { homeDirectory });
	const current = await deps.inspectTicket(identity, workflow.id, ticket.id, { homeDirectory });
	if (current.execution?.result !== undefined && current.status === "in-progress") {
		if (current.execution.result.outcome === "done" && current.execution.claim?.session_id !== ctx.sessionManager.getSessionId()) {
			const integrated = await integrateMutatingTicketResult(ctx, identity, currentWorkflow, current, { dependencies });
			if (integrated.action === "not_mutating") {
				ctx.ui.notify(`Ticket '${ticket.id}' has a submitted read-only result ready for coordinator acceptance.`, "info");
			}
			return { handled: true, action: integrated.action };
		}
		throw new ValidationError(
			`Ticket '${ticket.id}' already has a submitted result. Return to coordination for review; executor work must not resume under that claim.`,
		);
	}
	if (current.status === "open" && current.execution.claim === null) {
		if (plannedTicketDigest !== current.digest) {
			throw new ValidationError(`Ticket '${ticket.id}' changed after its execution plan was reviewed. Re-plan the ticket before dispatch.`);
		}
		const target = await ensureTicketExecutionTarget(ctx, identity, currentWorkflow, current, deps);
		if (target === null) return { handled: true, action: "git_plan_cancelled" };
		return createDedicatedTicketSession(ctx, identity, currentWorkflow, current, deps, {
			homeDirectory,
			contextWindowTokens,
			target,
		});
	}
	if (current.status !== "in-progress" || current.execution.claim === null) {
		throw new ValidationError(
			`Ticket '${ticket.id}' must be actionable and open, or have an active in-progress manual claim, before it can run or resume.`,
		);
	}
	if (current.execution.claim.executor !== "manual") {
		throw new ValidationError(`Ticket '${ticket.id}' is claimed by a non-manual executor and cannot resume through a Pi ticket session.`);
	}
	if (current.execution.claim.session_id === ctx.sessionManager.getSessionId()) {
		ctx.ui.notify(`This is already the claimed dedicated session for ${workflow.id}/${ticket.id}.`, "info");
		return { handled: true, action: "already_active" };
	}
	const executionTarget = await claimedExecutionTarget(identity, currentWorkflow, current, deps);
	if (executionTarget.target === null) {
		return recoverMissingExecutorSession(ctx, identity, currentWorkflow, current, deps, {
			homeDirectory,
			contextWindowTokens,
			reason: executionTarget.reason ?? "The claimed execution environment is missing",
		});
	}
	const target = executionTarget.target;
	if (target.mutates_project) {
		const source = await deps.assertCleanWorktree(identity.projectRoot);
		if (source.headBranch !== currentWorkflow.metadata.git.workflow_branch) {
			throw new GitStateError(
				`Mutating ticket resume requires clean checked-out workflow branch '${currentWorkflow.metadata.git.workflow_branch}'.`,
				{ details: { expected_branch: currentWorkflow.metadata.git.workflow_branch, actual_branch: source.headBranch } },
			);
		}
	}
	const sessions = await deps.listSessions(
		target.cwd,
		targetSessionDirectory(ctx.sessionManager, ctx.cwd, target.cwd),
	);
	const claimedSession = findSessionById(sessions, current.execution.claim.session_id, { expectedCwd: target.cwd });
	if (claimedSession === null) {
		return recoverMissingExecutorSession(ctx, identity, currentWorkflow, current, deps, {
			homeDirectory,
			contextWindowTokens,
			reason: "The claimed session is absent from the configured session storage",
		});
	}
	const stored = currentTicketSessionLocator(deps.openSession(claimedSession.path));
	if (stored === null) throw new ValidationError("The claimed Pi session is missing its DBZ Workflows locator; recover the claim explicitly.");
	assertLocatorMatches(stored, identity, currentWorkflow, current, target);
	const confirmed = await ctx.ui.confirm(
		`Resume ${workflow.id}/${ticket.id}?`,
		`Switch to claimed Pi session ${claimedSession.id} at ${claimedSession.path}.\nSession cwd: ${target.cwd}\nThe durable claim remains unchanged.`,
	);
	if (!confirmed) {
		ctx.ui.notify("Ticket resume was cancelled; the existing claim remains active.", "info");
		return { handled: true, action: "resume_cancelled" };
	}
	const prompt = `Resume only ${workflow.id}/${ticket.id} in cwd ${target.cwd}. Re-read the canonical ticket if needed, complete its contract, submit the normalized result with dbz_workflows_submit_result, then run /dbz-workflows continue ${workflow.id}.`;
	const targetCwd = target.cwd;
	const switched = await ctx.switchSession(claimedSession.path, {
		withSession: async (replacementCtx) => {
			if (resolve(replacementCtx.cwd) !== targetCwd) {
				replacementCtx.ui.notify(`Refusing ticket resume because replacement cwd '${replacementCtx.cwd}' does not match '${targetCwd}'. The claim remains active.`, "error");
				return;
			}
			try {
				await replacementCtx.sendUserMessage(prompt);
			} catch (error) {
				replacementCtx.ui.notify(
					`The claimed session resumed, but its continuation prompt could not be sent: ${error instanceof Error ? error.message : String(error)}. The claim remains active.`,
					"error",
				);
			}
		},
	});
	if (switched.cancelled) {
		ctx.ui.notify("Ticket resume was cancelled by a Pi session guard; the existing claim remains active.", "info");
		return { handled: true, action: "resume_cancelled" };
	}
	return { handled: true, action: "resumed" };
}

async function finishCoordinatorHandoff(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	ticket: any,
	locator: TicketSessionLocator,
	deps: TicketSessionDependencies,
): Promise<void> {
	if (resolve(ctx.cwd) !== locator.coordinator_cwd) {
		ctx.ui.notify(
			`Returned session cwd '${ctx.cwd}' does not match recorded coordinator cwd '${locator.coordinator_cwd}'. Canonical state and claims remain unchanged.`,
			"error",
		);
		return;
	}
	let integration: Awaited<ReturnType<typeof integrateMutatingTicketResult>> | undefined;
	let integrationError: string | undefined;
	if (ticket.execution.result.outcome === "done" && locator.mutates_project) {
		try {
			integration = await integrateMutatingTicketResult(ctx, identity, workflow, ticket, {
				dependencies: deps,
				worktreePath: locator.ticket_worktree ?? undefined,
			});
		} catch (error) {
			integrationError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Returned to coordination, but the mutating result was not integrated: ${integrationError}. The result and claim remain active for explicit retry.`,
				"error",
			);
		}
	}
	const prompt = coordinatorHandoffPrompt(ticket, ticket.execution.result.outcome, {
		integration,
		integrationError,
	});
	try {
		await ctx.sendUserMessage(prompt);
	} catch (error) {
		ctx.ui.notify(
			`Returned to coordination, but the canonical result handoff prompt could not be sent: ${error instanceof Error ? error.message : String(error)}. Inspect ${locator.workflow_id}/${locator.ticket_id} explicitly.`,
			"error",
		);
	}
}

async function createFreshCoordinationSession(
	ctx: ExtensionCommandContext,
	locator: TicketSessionLocator,
	deps: TicketSessionDependencies,
): Promise<string> {
	const sessionDir = targetSessionDirectory(ctx.sessionManager, ctx.cwd, locator.coordinator_cwd);
	const manager = deps.createSession(locator.coordinator_cwd, sessionDir);
	manager.appendSessionInfo(`DBZ ${locator.workflow_id} coordination`);
	manager.appendCustomEntry(COORDINATION_SESSION_LOCATOR_ENTRY, {
		version: 1,
		project_key: locator.project_key,
		workflow_id: locator.workflow_id,
		recovered_from_session_id: locator.coordinator_session_id,
	});
	return (await materializeFreshSession(manager)).path;
}

export async function returnToCoordinationSession(
	ctx: ExtensionCommandContext,
	_identity: any,
	requestedWorkflowId: string | undefined,
	{
		homeDirectory,
		dependencies,
	}: {
		homeDirectory?: string;
		dependencies?: Partial<TicketSessionDependencies>;
	} = {},
): Promise<{ handled: boolean; action?: string }> {
	const locator = currentTicketSessionLocator(ctx.sessionManager);
	if (locator === null) return { handled: false };
	if (requestedWorkflowId !== undefined && requestedWorkflowId !== locator.workflow_id) {
		throw new ValidationError(`This ticket session belongs to '${locator.workflow_id}', not requested workflow '${requestedWorkflowId}'.`);
	}
	if (ctx.sessionManager.getSessionId() !== locator.executor_session_id || resolve(ctx.cwd) !== locator.executor_cwd) {
		throw new ValidationError("The active Pi session does not match its DBZ Workflows executor-session locator.");
	}
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as TicketSessionDependencies;
	const identity = await deps.inspectGitProject(locator.coordinator_cwd);
	if (identity.projectKey !== locator.project_key) {
		throw new ValidationError("The recorded coordination checkout belongs to a different Git project lineage.");
	}
	const [workflow, ticket] = await Promise.all([
		deps.inspectWorkflow(identity, locator.workflow_id, { homeDirectory }),
		deps.inspectTicket(identity, locator.workflow_id, locator.ticket_id, { homeDirectory }),
	]);
	const result = assertResultReadyForCoordination(ticket, locator.claim_id);
	const coordinatorSessions = await deps.listSessions(locator.coordinator_cwd, dirname(locator.coordinator_session_file));
	const coordinator = findSessionById(coordinatorSessions, locator.coordinator_session_id, {
		expectedPath: locator.coordinator_session_file,
		expectedCwd: locator.coordinator_cwd,
	});
	if (coordinator !== null) {
		const confirmed = await ctx.ui.confirm(
			`Return ${locator.workflow_id}/${locator.ticket_id} to coordination?`,
			`Result outcome: ${result.outcome}\nCoordinator session: ${coordinator.id}\nCoordinator cwd: ${locator.coordinator_cwd}\nCanonical state will not be changed merely by switching sessions.`,
		);
		if (!confirmed) {
			ctx.ui.notify("Return to coordination was cancelled; canonical ticket state is unchanged.", "info");
			return { handled: true, action: "return_cancelled" };
		}
		const plainIdentity = { ...identity };
		const switched = await ctx.switchSession(coordinator.path, {
			withSession: async (replacementCtx) => {
				await finishCoordinatorHandoff(replacementCtx, plainIdentity, workflow, ticket, locator, deps);
			},
		});
		if (switched.cancelled) {
			ctx.ui.notify("Return to coordination was cancelled by a Pi session guard; canonical ticket state is unchanged.", "info");
			return { handled: true, action: "return_cancelled" };
		}
		return { handled: true, action: "returned" };
	}
	const confirmed = await ctx.ui.confirm(
		`Coordinator session ${locator.coordinator_session_id} is missing. Create a fresh replacement?`,
		[
			`Ticket: ${locator.workflow_id}/${locator.ticket_id}`,
			`Submitted outcome: ${result.outcome}`,
			`Replacement cwd: ${locator.coordinator_cwd}`,
			"The canonical ticket result and durable claim remain unchanged. The replacement will contain only coordination locator data; neither the missing coordinator transcript nor the executor transcript will be copied.",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("No replacement coordination session was created; canonical ticket state and claims are unchanged.", "warning");
		return { handled: true, action: "coordinator_recovery_cancelled" };
	}
	const replacementPath = await createFreshCoordinationSession(ctx, locator, deps);
	const plainIdentity = { ...identity };
	const switched = await ctx.switchSession(replacementPath, {
		withSession: async (replacementCtx) => {
			await finishCoordinatorHandoff(replacementCtx, plainIdentity, workflow, ticket, locator, deps);
		},
	});
	if (switched.cancelled) {
		ctx.ui.notify("Replacement coordination-session switching was cancelled; canonical ticket state is unchanged.", "info");
		return { handled: true, action: "coordinator_recovery_cancelled" };
	}
	return { handled: true, action: "coordinator_recovered" };
}
