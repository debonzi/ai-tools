import { homedir } from "node:os";
import type {
	AutocompleteItem,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { ERROR_CODES, ValidationError } from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import { applyMigrationPlan, createMigrationPlan } from "../../../../skills/dbz-workflows/lib/migration.mjs";
import { applySetupPlan, createSetupPlan } from "../../../../skills/dbz-workflows/lib/setup.mjs";
import { resolveActiveStorage } from "../../../../skills/dbz-workflows/lib/storage.mjs";
import { planSchedulerWave } from "../../../../skills/dbz-workflows/lib/scheduler.mjs";
import { listTickets, queryTicketReadiness } from "../../../../skills/dbz-workflows/lib/tickets.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	inspectWorkflow,
	listWorkflows,
	validateWorkflowContinuation,
} from "../../../../skills/dbz-workflows/lib/workflows.mjs";
import {
	returnToCoordinationSession,
	runOrResumeTicketSession,
} from "./sessions.ts";
import { runVerificationCommand } from "./verification.ts";
import {
	assertDialogUI,
	assertTrustedProject,
	formatError,
	formatMigrationPlan,
	formatSetupPlan,
	formatWorkflowDashboard,
	formatWorkflowList,
	promptExternalPath,
	promptStorageMode,
	ticketChoiceLabel,
	workflowChoiceLabel,
	type StorageMode,
} from "./ui.ts";

const ACTIONS = ["start", "continue", "status", "run", "verify", "reconfigure"] as const;

export interface CommandCache {
	workflows: Map<string, any>;
	tickets: Map<string, Map<string, any>>;
}

export interface CommandDependencies {
	inspectGitProject: typeof inspectGitProject;
	resolveActiveStorage: typeof resolveActiveStorage;
	createSetupPlan: typeof createSetupPlan;
	applySetupPlan: typeof applySetupPlan;
	createMigrationPlan: typeof createMigrationPlan;
	applyMigrationPlan: typeof applyMigrationPlan;
	createWorkflowReservationPlan: typeof createWorkflowReservationPlan;
	applyWorkflowReservationPlan: typeof applyWorkflowReservationPlan;
	createWorkflowStartPlan: typeof createWorkflowStartPlan;
	applyWorkflowStartPlan: typeof applyWorkflowStartPlan;
	listWorkflows: typeof listWorkflows;
	inspectWorkflow: typeof inspectWorkflow;
	validateWorkflowContinuation: typeof validateWorkflowContinuation;
	listTickets: typeof listTickets;
	queryTicketReadiness: typeof queryTicketReadiness;
	planSchedulerWave: typeof planSchedulerWave;
	runOrResumeTicketSession: typeof runOrResumeTicketSession;
	returnToCoordinationSession: typeof returnToCoordinationSession;
	runVerificationCommand: typeof runVerificationCommand;
}

const DEFAULT_DEPENDENCIES: CommandDependencies = {
	inspectGitProject,
	resolveActiveStorage,
	createSetupPlan,
	applySetupPlan,
	createMigrationPlan,
	applyMigrationPlan,
	createWorkflowReservationPlan,
	applyWorkflowReservationPlan,
	createWorkflowStartPlan,
	applyWorkflowStartPlan,
	listWorkflows,
	inspectWorkflow,
	validateWorkflowContinuation,
	listTickets,
	queryTicketReadiness,
	planSchedulerWave,
	runOrResumeTicketSession,
	returnToCoordinationSession,
	runVerificationCommand,
};

export function createCommandCache(): CommandCache {
	return { workflows: new Map(), tickets: new Map() };
}

function updateWorkflowCache(cache: CommandCache, workflows: any[]): void {
	cache.workflows.clear();
	for (const workflow of workflows) cache.workflows.set(workflow.id, workflow);
}

function updateTicketCache(cache: CommandCache, workflowId: string, tickets: any[]): void {
	cache.tickets.set(workflowId, new Map(tickets.map((ticket) => [ticket.id, ticket])));
}

function matchingItems(values: string[], prefix: string): AutocompleteItem[] | null {
	const normalized = prefix.toLocaleLowerCase("en-US");
	const matches = values
		.filter((value) => value.toLocaleLowerCase("en-US").startsWith(normalized))
		.map((value) => ({ value, label: value }));
	return matches.length > 0 ? matches : null;
}

export function commandArgumentCompletions(cache: CommandCache, prefix: string): AutocompleteItem[] | null {
	const firstSpace = prefix.indexOf(" ");
	if (firstSpace === -1) return matchingItems([...ACTIONS], prefix);
	const action = prefix.slice(0, firstSpace).trim();
	const argumentPrefix = prefix.slice(firstSpace + 1).trimStart();
	if (["continue", "status", "verify"].includes(action)) {
		const ids = [...cache.workflows.keys()].map((id) => `${action} ${id}`);
		return matchingItems(ids, `${action} ${argumentPrefix}`);
	}
	if (action === "run") {
		const ticketIds = [...new Set([...cache.tickets.values()].flatMap((tickets) => [...tickets.keys()]))].sort();
		return matchingItems(ticketIds.map((id) => `run ${id}`), `run ${argumentPrefix}`);
	}
	return null;
}

function splitArguments(value: string): string[] {
	return value.trim().length === 0 ? [] : value.trim().split(/\s+/u);
}

function assertNoExtraArguments(action: string, argumentsList: string[], maximum: number): void {
	if (argumentsList.length > maximum) {
		throw new ValidationError(`Usage: /dbz-workflows ${action}${maximum === 0 ? "" : " [id]"}`);
	}
}

async function selectWorkflow(
	ctx: ExtensionCommandContext,
	identity: any,
	requestedId: string | undefined,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
	options: { nonTerminalOnly?: boolean } = {},
): Promise<any | undefined> {
	const all = await deps.listWorkflows(identity, { homeDirectory });
	updateWorkflowCache(cache, all);
	const workflows = options.nonTerminalOnly
		? all.filter((workflow: any) => !["completed", "cancelled"].includes(workflow.phase))
		: all;
	if (requestedId !== undefined) {
		const workflow = workflows.find((candidate: any) => candidate.id === requestedId);
		if (!workflow) throw new ValidationError(`Workflow '${requestedId}' is not available for this action.`);
		return workflow;
	}
	if (workflows.length === 0) {
		ctx.ui.notify("No DBZ Workflows workflow is available for this action.", "info");
		return undefined;
	}
	if (workflows.length === 1) return workflows[0];
	const choices = new Map(workflows.map((workflow: any) => [workflowChoiceLabel(workflow), workflow]));
	const selected = await ctx.ui.select("Select a DBZ Workflows workflow", [...choices.keys()]);
	return selected === undefined ? undefined : choices.get(selected);
}

async function loadDashboard(
	identity: any,
	workflowId: string,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
	contextWindowTokens?: number,
): Promise<{ workflow: any; tickets: any[]; readiness: any }> {
	const [workflow, tickets, readiness] = await Promise.all([
		deps.inspectWorkflow(identity, workflowId, { homeDirectory }),
		deps.listTickets(identity, workflowId, { homeDirectory }),
		deps.queryTicketReadiness(identity, workflowId, { homeDirectory, contextWindowTokens }),
	]);
	cache.workflows.set(workflow.id, workflow);
	updateTicketCache(cache, workflowId, tickets);
	return { workflow, tickets, readiness };
}

async function runStorageSetup(
	ctx: ExtensionCommandContext,
	deps: CommandDependencies,
	{ homeDirectory, reconfigure }: { homeDirectory: string; reconfigure: boolean },
): Promise<void> {
	const identity = await deps.inspectGitProject(ctx.cwd);
	let active: any | undefined;
	try {
		active = await deps.resolveActiveStorage(identity, { homeDirectory });
	} catch (error: any) {
		if (error?.code !== ERROR_CODES.STORAGE_SETUP_REQUIRED) throw error;
	}
	const selected = await promptStorageMode(ctx, {
		currentMode: active?.mode,
		allowKeep: Boolean(active) && !reconfigure,
	});
	if (selected === undefined) {
		ctx.ui.notify("DBZ Workflows storage setup cancelled.", "info");
		return;
	}
	if (selected === "keep") {
		ctx.ui.notify(`DBZ Workflows remains configured at ${active.path}.`, "info");
		return;
	}
	const mode = selected as StorageMode;
	const externalPath = mode === "external" ? await promptExternalPath(ctx) : undefined;
	if (mode === "external" && externalPath === undefined) {
		ctx.ui.notify("DBZ Workflows storage setup cancelled before an external path was selected.", "info");
		return;
	}

	if (!active || (active.mode === mode && (mode !== "external" || active.path === externalPath))) {
		const plan = await deps.createSetupPlan(identity, {
			mode,
			externalPath,
			homeDirectory,
		});
		const confirmed = await ctx.ui.confirm("Apply DBZ Workflows setup?", formatSetupPlan(plan));
		if (!confirmed) {
			ctx.ui.notify("DBZ Workflows setup plan was not applied.", "info");
			return;
		}
		const result = await deps.applySetupPlan(plan, {
			identity,
			homeDirectory,
			authorization: { confirmed: true, planDigest: plan.plan_digest },
		});
		const gitReminder = result.git_changes?.length > 0
			? " Commit or otherwise resolve the reported project setup changes before starting a workflow."
			: "";
		ctx.ui.notify(`DBZ Workflows setup ${result.changed ? "applied" : "is already current"} at ${result.storage_path}.${gitReminder}`, "info");
		return;
	}

	const plan = await deps.createMigrationPlan(identity, {
		mode,
		externalPath,
		homeDirectory,
	});
	ctx.ui.notify(plan.disclaimer, "warning");
	const confirmed = await ctx.ui.confirm("Migrate DBZ Workflows storage?", formatMigrationPlan(plan));
	if (!confirmed) {
		ctx.ui.notify("DBZ Workflows migration plan was not applied.", "info");
		return;
	}
	const result = await deps.applyMigrationPlan(plan, {
		identity,
		homeDirectory,
		authorization: { confirmed: true, planDigest: plan.plan_digest },
	});
	ctx.ui.notify(
		result.changed
			? `DBZ Workflows storage migrated to ${result.storage_path}. The previous storage remains at ${result.backup_path}.`
			: `DBZ Workflows storage is already active at ${result.storage_path}.`,
		"info",
	);
}

async function startWorkflow(
	ctx: ExtensionCommandContext,
	identity: any,
	deps: CommandDependencies,
	homeDirectory: string,
	cache: CommandCache,
): Promise<void> {
	const title = (await ctx.ui.input("Workflow title", "A concise initiative title"))?.trim();
	if (!title) {
		ctx.ui.notify("Workflow start cancelled before a title was provided.", "info");
		return;
	}
	const initialIdea = (await ctx.ui.editor(
		"Initial workflow idea",
		"Describe the problem, intended outcome, and any known constraints.",
	))?.trim();
	if (!initialIdea) {
		ctx.ui.notify("Workflow start cancelled before an initial idea was provided.", "info");
		return;
	}
	const reservationPlan = await deps.createWorkflowReservationPlan(identity, {
		title,
		baseBranch: identity.headRef ?? undefined,
		homeDirectory,
	});
	const reservationConfirmed = await ctx.ui.confirm(
		`Reserve ${reservationPlan.workflow.id}?`,
		[
			`Workflow: ${reservationPlan.workflow.id} — ${reservationPlan.workflow.title}`,
			`Base branch: ${reservationPlan.source.base_branch ?? "detached HEAD"}`,
			`Base commit: ${reservationPlan.source.head_commit}`,
			...(reservationPlan.reservation_commit
				? ["A dedicated metadata commit will reserve this ID on the selected base branch."]
				: ["The workflow ID will be reserved in external canonical storage."]),
		].join("\n"),
	);
	if (!reservationConfirmed) {
		ctx.ui.notify("Workflow ID reservation was not applied.", "info");
		return;
	}
	const reserved = await deps.applyWorkflowReservationPlan(reservationPlan, {
		identity,
		homeDirectory,
		authorization: { confirmed: true, planDigest: reservationPlan.plan_digest },
	});
	const startPlan = await deps.createWorkflowStartPlan(identity, {
		reservation: reserved.reservation,
		initialIdea,
		homeDirectory,
	});
	const startConfirmed = await ctx.ui.confirm(
		`Create workflow branch ${startPlan.branch_plan.branch}?`,
		[
			`Reserved workflow: ${startPlan.reservation.workflow.id}`,
			`Branch: ${startPlan.branch_plan.branch}`,
			`Base commit: ${startPlan.reservation.base_commit}`,
			`Canonical directory: ${startPlan.artifacts.directory}`,
			"The branch will be created and checked out, then the initial workflow and spec artifacts will be created.",
		].join("\n"),
	);
	if (!startConfirmed) {
		ctx.ui.notify(
			`Workflow branch creation cancelled. ${reserved.reservation.workflow.id} remains durably reserved and will not be reused.`,
			"warning",
		);
		return;
	}
	const result = await deps.applyWorkflowStartPlan(startPlan, {
		identity,
		homeDirectory,
		authorization: { confirmed: true, planDigest: startPlan.plan_digest },
	});
	cache.workflows.set(result.workflow.id, result.workflow);
	ctx.ui.notify(
		`Started ${result.workflow.id} on ${result.branch.branch}. Discovery artifacts are ready at ${result.workflow.directory}.`,
		"info",
	);
}

async function continueWorkflow(
	ctx: ExtensionCommandContext,
	identity: any,
	workflowId: string | undefined,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	const selected = await selectWorkflow(ctx, identity, workflowId, deps, cache, homeDirectory, { nonTerminalOnly: true });
	if (!selected) return;
	const continuation = await deps.validateWorkflowContinuation(identity, selected.id, { homeDirectory });
	const dashboard = await loadDashboard(
		identity,
		selected.id,
		deps,
		cache,
		homeDirectory,
		ctx.model?.contextWindow,
	);
	ctx.ui.notify(formatWorkflowDashboard(dashboard.workflow, dashboard.tickets, dashboard.readiness), "info");
	if (continuation.requires_branch_switch) {
		ctx.ui.notify(
			`Continuation validated, but the current branch is not ${continuation.workflow_branch}. Switch through a reviewed Git operation before mutating project or project-local workflow files.`,
			"warning",
		);
	}
}

async function showStatus(
	ctx: ExtensionCommandContext,
	identity: any,
	workflowId: string | undefined,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	if (workflowId === undefined) {
		const workflows = await deps.listWorkflows(identity, { homeDirectory });
		updateWorkflowCache(cache, workflows);
		ctx.ui.notify(formatWorkflowList(workflows), "info");
		if (workflows.length === 0) return;
		if (workflows.length === 1) workflowId = workflows[0].id;
		else {
			const choices = new Map(workflows.map((candidate: any) => [workflowChoiceLabel(candidate), candidate.id]));
			const selected = await ctx.ui.select("Select a workflow for detailed status", [...choices.keys()]);
			if (selected === undefined) return;
			const selectedId = choices.get(selected);
			if (selectedId === undefined) throw new ValidationError("The selected workflow is no longer available.");
			workflowId = selectedId;
		}
	}
	const dashboard = await loadDashboard(identity, workflowId, deps, cache, homeDirectory, ctx.model?.contextWindow);
	ctx.ui.notify(formatWorkflowDashboard(dashboard.workflow, dashboard.tickets, dashboard.readiness), "info");
}

async function runTicket(
	ctx: ExtensionCommandContext,
	identity: any,
	requestedTicketId: string | undefined,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	const workflow = await selectWorkflow(ctx, identity, undefined, deps, cache, homeDirectory, { nonTerminalOnly: true });
	if (!workflow) return;
	const dashboard = await loadDashboard(identity, workflow.id, deps, cache, homeDirectory, ctx.model?.contextWindow);
	const actionable = new Set(dashboard.readiness.actionable_ticket_ids);
	const resumable = (candidate: any) => (
		candidate.status === "in-progress" && candidate.execution?.claim?.executor === "manual"
	);
	let ticket = requestedTicketId === undefined
		? undefined
		: dashboard.tickets.find((candidate) => candidate.id === requestedTicketId);
	if (requestedTicketId !== undefined && !ticket) {
		throw new ValidationError(`Ticket '${requestedTicketId}' was not found in workflow '${workflow.id}'.`);
	}
	if (!ticket) {
		const choices = new Map(
			dashboard.tickets
				.filter((candidate) => actionable.has(candidate.id) || resumable(candidate))
				.map((candidate) => [ticketChoiceLabel(candidate), candidate]),
		);
		if (choices.size === 0) {
			ctx.ui.notify(`Workflow '${workflow.id}' has no actionable or resumable manual tickets.`, "info");
			return;
		}
		const selected = await ctx.ui.select("Select an actionable or resumable ticket", [...choices.keys()]);
		if (selected === undefined) return;
		ticket = choices.get(selected);
	}
	let plannedTicketDigest: string | undefined;
	if (ticket.status === "open" && ticket.execution?.claim === null) {
		const plan = await deps.planSchedulerWave(identity, workflow.id, {
			executor: "manual",
			requestedTicketIds: [ticket.id],
			maxConcurrency: 1,
			contextWindowTokens: ctx.model?.contextWindow,
			homeDirectory,
		});
		plannedTicketDigest = plan.tickets[0]?.digest;
	}
	await deps.runOrResumeTicketSession(ctx, identity, workflow, ticket, {
		homeDirectory,
		contextWindowTokens: ctx.model?.contextWindow,
		plannedTicketDigest,
	});
}

async function previewVerification(
	ctx: ExtensionCommandContext,
	identity: any,
	workflowId: string | undefined,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	const workflow = await selectWorkflow(ctx, identity, workflowId, deps, cache, homeDirectory);
	if (!workflow) return;
	const dashboard = await loadDashboard(identity, workflow.id, deps, cache, homeDirectory, ctx.model?.contextWindow);
	ctx.ui.notify(formatWorkflowDashboard(dashboard.workflow, dashboard.tickets, dashboard.readiness), "info");
	await deps.runVerificationCommand(ctx, identity, dashboard.workflow, { homeDirectory });
}

async function dispatchAction(
	action: string,
	argumentsList: string[],
	ctx: ExtensionCommandContext,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	if (action === "reconfigure") {
		assertNoExtraArguments(action, argumentsList, 0);
		await runStorageSetup(ctx, deps, { homeDirectory, reconfigure: true });
		return;
	}
	if (action === "continue") {
		assertNoExtraArguments(action, argumentsList, 1);
		const returned = await deps.returnToCoordinationSession(ctx, undefined, argumentsList[0], { homeDirectory });
		if (returned.handled) return;
	}
	const identity = await deps.inspectGitProject(ctx.cwd);
	await deps.resolveActiveStorage(identity, { homeDirectory });
	if (action === "start") {
		assertNoExtraArguments(action, argumentsList, 0);
		await startWorkflow(ctx, identity, deps, homeDirectory, cache);
		return;
	}
	if (action === "continue") {
		await continueWorkflow(ctx, identity, argumentsList[0], deps, cache, homeDirectory);
		return;
	}
	if (action === "status") {
		assertNoExtraArguments(action, argumentsList, 1);
		await showStatus(ctx, identity, argumentsList[0], deps, cache, homeDirectory);
		return;
	}
	if (action === "run") {
		assertNoExtraArguments(action, argumentsList, 1);
		await runTicket(ctx, identity, argumentsList[0], deps, cache, homeDirectory);
		return;
	}
	if (action === "verify") {
		assertNoExtraArguments(action, argumentsList, 1);
		await previewVerification(ctx, identity, argumentsList[0], deps, cache, homeDirectory);
		return;
	}
	throw new ValidationError(`Unknown DBZ Workflows action '${action}'. Expected one of: ${ACTIONS.join(", ")}.`);
}

async function openHub(
	ctx: ExtensionCommandContext,
	deps: CommandDependencies,
	cache: CommandCache,
	homeDirectory: string,
): Promise<void> {
	const options = [
		"Start new workflow",
		"Continue workflow",
		"Show workflow status",
		"Run or resume ticket",
		"Verify workflow",
		"Reconfigure storage",
	];
	const selected = await ctx.ui.select("DBZ Workflows", options);
	const actionByLabel = new Map([
		[options[0], "start"],
		[options[1], "continue"],
		[options[2], "status"],
		[options[3], "run"],
		[options[4], "verify"],
		[options[5], "reconfigure"],
	]);
	if (selected === undefined) return;
	const action = actionByLabel.get(selected);
	if (action === undefined) throw new ValidationError("The selected DBZ Workflows hub action is unavailable.");
	await dispatchAction(action, [], ctx, deps, cache, homeDirectory);
}

async function guardedCommand(
	ctx: ExtensionCommandContext,
	operation: string,
	callback: () => Promise<void>,
): Promise<void> {
	try {
		assertTrustedProject(ctx);
		assertDialogUI(ctx, operation);
		await callback();
	} catch (error) {
		if (!ctx.hasUI) throw error;
		ctx.ui.notify(formatError(error), "error");
	}
}

export function registerDbzWorkflowCommands(
	pi: ExtensionAPI,
	{
		dependencies,
		cache = createCommandCache(),
		homeDirectory = homedir(),
	}: {
		dependencies?: Partial<CommandDependencies>;
		cache?: CommandCache;
		homeDirectory?: string;
	} = {},
): CommandCache {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as CommandDependencies;
	pi.registerCommand("dbz-workflows-setup", {
		description: "Configure or reconfigure DBZ Workflows storage for the trusted current project",
		handler: async (args, ctx) => guardedCommand(ctx, "DBZ Workflows setup", async () => {
			if (args.trim()) throw new ValidationError("Usage: /dbz-workflows-setup");
			await runStorageSetup(ctx, deps, { homeDirectory, reconfigure: false });
		}),
	});
	pi.registerCommand("dbz-workflows", {
		description: "Open the DBZ Workflows hub or run start, continue, status, run, verify, or reconfigure",
		getArgumentCompletions: (prefix) => commandArgumentCompletions(cache, prefix),
		handler: async (args, ctx) => guardedCommand(ctx, "DBZ Workflows commands", async () => {
			const [action, ...argumentsList] = splitArguments(args);
			if (action === undefined) await openHub(ctx, deps, cache, homeDirectory);
			else await dispatchAction(action, argumentsList, ctx, deps, cache, homeDirectory);
		}),
	});
	return cache;
}
