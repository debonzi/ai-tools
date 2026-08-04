import assert from "node:assert/strict";
import test from "node:test";
import dbzWorkflowsExtension from "./index.ts";
import {
	commandArgumentCompletions,
	createCommandCache,
	registerDbzWorkflowCommands,
} from "./commands.ts";
import {
	boundedToolText,
	registerDbzWorkflowTools,
	runQueuedMutation,
} from "./tools.ts";

function makePiHarness() {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const events = new Map<string, any[]>();
	const busHandlers = new Map<string, Array<(value: unknown) => unknown>>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => unknown) {
				busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, value: unknown) {
				for (const handler of busHandlers.get(name) ?? []) handler(value);
			},
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		on(name: string, handler: any) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		getAllTools() {
			return ["read", "bash", "edit", "write", "grep", "find", "ls", ...tools.keys()].map((name) => ({ name }));
		},
		getActiveTools() {
			return [...activeTools, ...tools.keys()];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	};
	return { pi, commands, tools, events, busHandlers, activeTools: () => activeTools };
}

function makeContext({
	trusted = true,
	hasUI = true,
	mode = "tui",
	selectValues = [],
	inputValues = [],
	editorValues = [],
	confirmValues = [],
	sessionId = "session-1",
}: {
	trusted?: boolean;
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	selectValues?: Array<string | undefined>;
	inputValues?: Array<string | undefined>;
	editorValues?: Array<string | undefined>;
	confirmValues?: boolean[];
	sessionId?: string | undefined;
} = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const inputs: Array<{ title: string; placeholder?: string }> = [];
	const editors: Array<{ title: string; prefill?: string }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const ctx = {
		cwd: "/project",
		mode,
		hasUI,
		model: { contextWindow: 128_000 },
		isProjectTrusted: () => trusted,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/sessions/coordinator.jsonl",
			getSessionDir: () => "/sessions",
			getBranch: () => [],
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async select(title: string, options: string[]) {
				selects.push({ title, options });
				return selectValues.shift();
			},
			async input(title: string, placeholder?: string) {
				inputs.push({ title, placeholder });
				return inputValues.shift();
			},
			async editor(title: string, prefill?: string) {
				editors.push({ title, prefill });
				return editorValues.shift();
			},
			async confirm(title: string, message: string) {
				confirms.push({ title, message });
				return confirmValues.shift() ?? false;
			},
		},
	};
	return { ctx, notifications, selects, inputs, editors, confirms };
}

const identity = {
	projectRoot: "/project",
	projectKey: `git-sha1-${"a".repeat(40)}`,
	objectFormat: "sha1",
	rootCommit: "a".repeat(40),
	headRef: "main",
};

const workflow = {
	id: "WF-0001",
	title: "Example workflow",
	slug: "example-workflow",
	phase: "discovery",
	conditions: [],
	current_baseline: null,
	path: "/storage/WF-0001-example-workflow/workflow.md",
	directory: "/storage/WF-0001-example-workflow",
	digest: "1".repeat(64),
	metadata: {
		git: { workflow_branch: "dbz-workflows/WF-0001-example-workflow" },
	},
};

const ticket = {
	id: "T-0001",
	title: "Research a bounded question",
	type: "research",
	status: "open",
	path: "/storage/WF-0001-example-workflow/tickets/T-0001-research.md",
	digest: "2".repeat(64),
	execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim: null },
};

const readiness = {
	workflow_phase: "discovery",
	current_baseline: null,
	actionable_ticket_ids: ["T-0001"],
	tickets: [{ id: "T-0001", actionable: true, stale: false, reasons: [] }],
};

test("entry point registers both commands and the focused S09 tool surface", () => {
	const harness = makePiHarness();
	dbzWorkflowsExtension(harness.pi as any);
	assert.deepEqual([...harness.commands.keys()], ["dbz-workflows-setup", "dbz-workflows"]);
	assert.deepEqual([...harness.tools.keys()], [
		"dbz_workflows_inspect",
		"dbz_workflows_read_frontmatter",
		"dbz_workflows_read_section",
		"dbz_workflows_update_spec_sections",
		"dbz_workflows_create_ticket",
		"dbz_workflows_transition_ticket",
		"dbz_workflows_query_actionable",
		"dbz_workflows_plan_wave",
		"dbz_workflows_claim_ticket",
		"dbz_workflows_recover_claim",
		"dbz_workflows_submit_result",
		"dbz_workflows_accept_result",
		"dbz_workflows_crew_executor",
	]);
});

test("dedicated read-only sessions disable mutating built-ins while retaining configured read-only tools", async () => {
	const harness = makePiHarness();
	dbzWorkflowsExtension(harness.pi as any);
	const locator = {
		version: 1,
		project_key: identity.projectKey,
		workflow_id: "WF-0001",
		workflow_slug: "example-workflow",
		ticket_id: "T-0001",
		ticket_slug: "research-a-question",
		claim_id: "claim-1",
		executor_session_id: "executor-session",
		executor_cwd: "/project",
		mutates_project: false,
		ticket_branch: null,
		ticket_worktree: null,
		coordinator_session_id: "coordinator-session",
		coordinator_session_file: "/sessions/coordinator.jsonl",
		coordinator_cwd: "/project",
	};
	const ctx = makeContext({ sessionId: "executor-session" }).ctx as any;
	ctx.sessionManager.getBranch = () => [{
		type: "custom",
		customType: "dbz-workflows-ticket-session",
		data: locator,
	}];
	for (const handler of harness.events.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
	const active = harness.activeTools();
	assert.equal(active.includes("bash"), false);
	assert.equal(active.includes("edit"), false);
	assert.equal(active.includes("write"), false);
	for (const name of ["read", "dbz_workflows_submit_result"]) {
		assert.equal(active.includes(name), true);
	}
});

test("DBZ Crew worker sessions disable all canonical DBZ Workflows tools", async () => {
	const previous = process.env.DBZ_WORKFLOWS_EXECUTOR;
	process.env.DBZ_WORKFLOWS_EXECUTOR = "dbz-crew";
	try {
		const harness = makePiHarness();
		dbzWorkflowsExtension(harness.pi as any);
		const ctx = makeContext().ctx as any;
		for (const handler of harness.events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		assert.equal(harness.activeTools().some((name) => name.startsWith("dbz_workflows_")), false);
		assert.equal(harness.activeTools().includes("read"), true);
	} finally {
		if (previous === undefined) delete process.env.DBZ_WORKFLOWS_EXECUTOR;
		else process.env.DBZ_WORKFLOWS_EXECUTOR = previous;
	}
});

test("command completions expose direct actions and cached workflow and ticket IDs", () => {
	const cache = createCommandCache();
	cache.workflows.set("WF-0003", { id: "WF-0003" });
	cache.tickets.set("WF-0003", new Map([["T-0007", { id: "T-0007" }]]));
	assert.deepEqual(
		commandArgumentCompletions(cache, "st")?.map(({ value }) => value),
		["start", "status"],
	);
	assert.deepEqual(
		commandArgumentCompletions(cache, "status WF")?.map(({ value }) => value),
		["status WF-0003"],
	);
	assert.deepEqual(
		commandArgumentCompletions(cache, "run T-")?.map(({ value }) => value),
		["run T-0007"],
	);
});

test("commands reject untrusted projects and noninteractive modes before inspecting the repository", async () => {
	let inspections = 0;
	const harness = makePiHarness();
	registerDbzWorkflowCommands(harness.pi as any, {
		dependencies: {
			inspectGitProject: async () => {
				inspections += 1;
				return identity as any;
			},
		},
	});

	const untrusted = makeContext({ trusted: false });
	await harness.commands.get("dbz-workflows").handler("status", untrusted.ctx);
	assert.equal(inspections, 0);
	assert.match(untrusted.notifications[0]?.message ?? "", /trusted project context/u);

	const print = makeContext({ mode: "print", hasUI: false });
	await assert.rejects(
		harness.commands.get("dbz-workflows-setup").handler("", print.ctx),
		/TUI or RPC UI.*never assume confirmation/u,
	);
	assert.equal(inspections, 0);
	assert.equal(print.confirms.length, 0);
});

test("setup shows selected and effective external paths and applies only the confirmed reviewed plan", async () => {
	const harness = makePiHarness();
	const applied: any[] = [];
	const plan = {
		operation: "setup",
		plan_digest: "d".repeat(64),
		mode: "external",
		action: "create",
		destination: {
			selected_path: "/chosen/link",
			effective_path: "/effective/storage",
		},
		lineage_notice: { message: "Shared Git lineage notice." },
		changes: [{ action: "create_root_manifest", path: "/effective/storage/dbz-workflows.md" }],
	};
	registerDbzWorkflowCommands(harness.pi as any, {
		homeDirectory: "/home/test",
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveActiveStorage: async () => {
				throw Object.assign(new Error("setup required"), { code: "storage_setup_required" });
			},
			createSetupPlan: async () => plan as any,
			applySetupPlan: async (_plan, options) => {
				applied.push(options);
				return {
					changed: true,
					storage_path: "/chosen/link",
					git_changes: [],
				} as any;
			},
		},
	});
	const ui = makeContext({
		selectValues: ["External — use one exact absolute path"],
		inputValues: ["/chosen/link"],
		confirmValues: [true],
	});
	await harness.commands.get("dbz-workflows-setup").handler("", ui.ctx);
	assert.equal(ui.confirms.length, 1);
	assert.match(ui.confirms[0].message, /Selected path: \/chosen\/link/u);
	assert.match(ui.confirms[0].message, /Effective path: \/effective\/storage/u);
	assert.match(ui.confirms[0].message, /Shared Git lineage notice/u);
	assert.deepEqual(applied[0].authorization, {
		confirmed: true,
		planDigest: plan.plan_digest,
	});
});

test("reconfiguration displays the exact migration disclaimer and preserves the reviewed authorization boundary", async () => {
	const harness = makePiHarness();
	const disclaimer = "Migration may cross filesystem boundaries and cannot be fully atomic.";
	let authorization: any;
	const plan = {
		operation: "migration",
		plan_digest: "e".repeat(64),
		action: "migrate",
		disclaimer,
		source: { mode: "project", selected_path: "/project/dbz-workflows" },
		destination: {
			mode: "managed",
			selected_path: "/home/test/.local/share/dbz-workflows/projects/key",
			effective_path: "/home/test/.local/share/dbz-workflows/projects/key",
		},
		backup_path: "/project/dbz-workflows.migrated-20260803T153000Z",
		changes: [{ action: "verified_copy", to: "/tmp/copy" }],
	};
	registerDbzWorkflowCommands(harness.pi as any, {
		homeDirectory: "/home/test",
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveActiveStorage: async () => ({ mode: "project", path: "/project/dbz-workflows" }) as any,
			createMigrationPlan: async () => plan as any,
			applyMigrationPlan: async (_plan, options) => {
				authorization = options.authorization;
				return {
					changed: true,
					storage_path: plan.destination.selected_path,
					backup_path: plan.backup_path,
				} as any;
			},
		},
	});
	const ui = makeContext({
		mode: "rpc",
		selectValues: ["Managed — ~/.local/share/dbz-workflows/projects/<project-key>"],
		confirmValues: [true],
	});
	await harness.commands.get("dbz-workflows").handler("reconfigure", ui.ctx);
	assert.ok(ui.notifications.some(({ message, level }) => level === "warning" && message === disclaimer));
	assert.match(ui.confirms[0]?.message ?? "", /Migration may cross filesystem boundaries/u);
	assert.match(ui.confirms[0]?.message ?? "", /Preserved backup/u);
	assert.deepEqual(authorization, { confirmed: true, planDigest: plan.plan_digest });
});

test("direct status, continue, run, and verify actions use core validation and dedicated-session dispatch", async () => {
	const calls: string[] = [];
	const harness = makePiHarness();
	registerDbzWorkflowCommands(harness.pi as any, {
		homeDirectory: "/home/test",
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveActiveStorage: async () => ({ mode: "managed", path: "/storage" }) as any,
			listWorkflows: async () => [workflow] as any,
			inspectWorkflow: async () => workflow as any,
			listTickets: async () => [ticket] as any,
			queryTicketReadiness: async () => readiness as any,
			validateWorkflowContinuation: async () => {
				calls.push("continue");
				return {
					workflow,
					workflow_branch: workflow.metadata.git.workflow_branch,
					requires_branch_switch: false,
				} as any;
			},
			planSchedulerWave: async () => {
				calls.push("plan-wave");
				return {
					tickets: [{ digest: ticket.digest, mutates_project: false }],
				} as any;
			},
			runOrResumeTicketSession: async (_ctx, _identity, _workflow, selected, options) => {
				calls.push(`run-session:${selected.id}:${options.plannedTicketDigest}`);
				return { handled: true, action: "created" };
			},
		},
	});
	const ui = makeContext();
	const command = harness.commands.get("dbz-workflows");
	await command.handler("status WF-0001", ui.ctx);
	await command.handler("continue WF-0001", ui.ctx);
	await command.handler("run T-0001", ui.ctx);
	await command.handler("verify WF-0001", ui.ctx);
	assert.deepEqual(calls, ["continue", "plan-wave", `run-session:T-0001:${ticket.digest}`]);
	assert.ok(ui.notifications.some(({ message }) => /Actionable tickets: T-0001/u.test(message)));
	assert.ok(ui.notifications.some(({ message }) => /verification\.md/u.test(message)));
});

test("start confirms reservation and branch plans separately and ties both applies to their digests", async () => {
	const harness = makePiHarness();
	const authorizations: any[] = [];
	const reservationPlan = {
		plan_digest: "3".repeat(64),
		workflow: { id: "WF-0002", title: "New workflow" },
		source: { base_branch: "main", head_commit: "a".repeat(40) },
		reservation_commit: null,
	};
	const reservation = {
		workflow: { id: "WF-0002", title: "New workflow" },
		base_commit: "a".repeat(40),
	};
	const startPlan = {
		plan_digest: "4".repeat(64),
		reservation,
		branch_plan: { branch: "dbz-workflows/WF-0002-new-workflow" },
		artifacts: { directory: "/storage/WF-0002-new-workflow" },
	};
	registerDbzWorkflowCommands(harness.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveActiveStorage: async () => ({ mode: "managed", path: "/storage" }) as any,
			createWorkflowReservationPlan: async () => reservationPlan as any,
			applyWorkflowReservationPlan: async (_plan, options) => {
				authorizations.push(options.authorization);
				return { reservation } as any;
			},
			createWorkflowStartPlan: async () => startPlan as any,
			applyWorkflowStartPlan: async (_plan, options) => {
				authorizations.push(options.authorization);
				return {
					workflow: { ...workflow, id: "WF-0002", directory: startPlan.artifacts.directory },
					branch: { branch: startPlan.branch_plan.branch },
				} as any;
			},
		},
	});
	const ui = makeContext({
		inputValues: ["New workflow"],
		editorValues: ["Initial idea"],
		confirmValues: [true, true],
	});
	await harness.commands.get("dbz-workflows").handler("start", ui.ctx);
	assert.equal(ui.confirms.length, 2);
	assert.deepEqual(authorizations, [
		{ confirmed: true, planDigest: reservationPlan.plan_digest },
		{ confirmed: true, planDigest: startPlan.plan_digest },
	]);
});

test("every mutating tool names itself and prohibits direct managed-frontmatter edits", () => {
	const harness = makePiHarness();
	registerDbzWorkflowTools(harness.pi as any);
	const mutating = [...harness.tools.values()].filter((tool) => tool.promptGuidelines !== undefined);
	assert.equal(mutating.length, 7);
	for (const tool of mutating) {
		assert.match(tool.description, new RegExp(tool.name, "u"));
		assert.match(tool.description, /frontmatter directly/u);
		assert.ok(tool.promptGuidelines.length > 0);
		for (const guideline of tool.promptGuidelines) {
			assert.match(guideline, new RegExp(tool.name, "u"));
			assert.match(guideline, /frontmatter directly/u);
		}
	}
});

test("tools refuse untrusted project data before calling core inspection", async () => {
	const harness = makePiHarness();
	let inspected = false;
	registerDbzWorkflowTools(harness.pi as any, {
		dependencies: {
			inspectGitProject: async () => {
				inspected = true;
				return identity as any;
			},
		},
	});
	const untrusted = makeContext({ trusted: false });
	await assert.rejects(
		harness.tools.get("dbz_workflows_inspect").execute(
			"call-untrusted",
			{ action: "list_workflows" },
			undefined,
			undefined,
			untrusted.ctx,
		),
		/trusted project context/u,
	);
	assert.equal(inspected, false);
});

test("mutating tools enter Pi's file mutation queue around core locked operations", async () => {
	const harness = makePiHarness();
	const queued: string[] = [];
	let updated = false;
	registerDbzWorkflowTools(harness.pi as any, {
		homeDirectory: "/home/test",
		fileMutationQueue: (async (path: string, callback: () => Promise<any>) => {
			queued.push(path);
			return callback();
		}) as any,
		dependencies: {
			inspectGitProject: async () => identity as any,
			inspectSpec: async () => ({
				path: "/storage/WF-0001-example-workflow/spec.md",
				digest: "5".repeat(64),
			}) as any,
			updateSpecDraftSections: async () => {
				updated = true;
				return { changed: true } as any;
			},
		},
	});
	const ui = makeContext();
	await harness.tools.get("dbz_workflows_update_spec_sections").execute(
		"call-1",
		{
			workflow_id: "WF-0001",
			expected_workflow_digest: "1".repeat(64),
			expected_spec_digest: "5".repeat(64),
			updates: [{ heading: "Scope", content: "Updated", operation: "replace" }],
		},
		undefined,
		undefined,
		ui.ctx,
	);
	assert.deepEqual(queued, ["/storage/WF-0001-example-workflow/spec.md"]);
	assert.equal(updated, true);
});

test("queued mutations use stable sorted target order", async () => {
	const events: string[] = [];
	await runQueuedMutation(
		["/tmp/z", "/tmp/a", "/tmp/z"],
		async () => {
			events.push("mutation");
		},
		(async (path: string, callback: () => Promise<void>) => {
			events.push(`enter:${path}`);
			const value = await callback();
			events.push(`leave:${path}`);
			return value;
		}) as any,
	);
	assert.deepEqual(events, [
		"enter:/tmp/a",
		"enter:/tmp/z",
		"mutation",
		"leave:/tmp/z",
		"leave:/tmp/a",
	]);
});

test("tool output is bounded by Pi's byte and line limits", () => {
	const value = { lines: Array.from({ length: 3_000 }, (_, index) => `${index}-${"x".repeat(80)}`) };
	const result = boundedToolText(value);
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 50 * 1024);
	assert.ok(result.text.split("\n").length <= 2_000);
	assert.match(result.text, /Output truncated/u);
});

test("the generic claim tool cannot bypass reviewed worktree dispatch for mutating tickets", async () => {
	const harness = makePiHarness();
	let claimed = false;
	registerDbzWorkflowTools(harness.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			inspectTicket: async () => ({
				...ticket,
				type: "implementation",
				metadata: { type: "implementation" },
			}) as any,
			startManualExecution: async () => {
				claimed = true;
				return {} as any;
			},
		},
	});
	const ui = makeContext();
	await assert.rejects(
		harness.tools.get("dbz_workflows_claim_ticket").execute(
			"call-claim",
			{
				workflow_id: "WF-0001",
				ticket_id: "T-0001",
				expected_ticket_digest: ticket.digest,
			},
			undefined,
			undefined,
			ui.ctx,
		),
		/complete ticket-worktree Git plan.*reviewed and applied/u,
	);
	assert.equal(claimed, false);
});

test("claim recovery requires interactive UI and never assumes confirmation", async () => {
	const harness = makePiHarness();
	let recovered = false;
	registerDbzWorkflowTools(harness.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			inspectTicket: async () => ({
				...ticket,
				execution: {
					...ticket.execution,
					claim: { claim_id: "claim-1", executor: "manual", session_id: "old", claimed_at: "2026-08-03T15:30:00.000Z" },
				},
			}) as any,
			recoverTicketClaim: async () => {
				recovered = true;
				return {} as any;
			},
		},
	});
	const noUi = makeContext({ mode: "json", hasUI: false });
	await assert.rejects(
		harness.tools.get("dbz_workflows_recover_claim").execute(
			"call-2",
			{
				workflow_id: "WF-0001",
				ticket_id: "T-0001",
				expected_ticket_digest: ticket.digest,
				rationale: "Previous session is unavailable",
			},
			undefined,
			undefined,
			noUi.ctx,
		),
		/TUI or RPC UI.*never assume confirmation/u,
	);
	assert.equal(recovered, false);
	assert.equal(noUi.confirms.length, 0);
});
