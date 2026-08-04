import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCrewExecutionPrompt,
	CREW_COMPLETION_EVENT_CHANNEL,
	createCrewTaskId,
	crewAdapterResourceAvailable,
	DBZ_CREW_TOOL_NAME,
	normalizeCrewExecutorResult,
	registerDbzCrewExecutor,
} from "./executors/dbz-crew.ts";

const NOW = "2026-08-03T15:30:00.000Z";
const SHA = "a".repeat(64);
const identity = {
	projectRoot: "/project",
	projectKey: `git-sha1-${"a".repeat(40)}`,
	objectFormat: "sha1",
	rootCommit: "a".repeat(40),
};
const workflow = {
	id: "WF-0001",
	title: "Parallel research",
	slug: "parallel-research",
	metadata: { git: { workflow_branch: "dbz-workflows/WF-0001-parallel-research" } },
};

function ticket(id: string, type = "research", overrides: Record<string, any> = {}) {
	const { metadata: metadataOverrides = {}, ...ticketOverrides } = overrides;
	const metadata = {
		artifact: "ticket",
		schema_version: 1,
		id,
		workflow_id: workflow.id,
		title: `${type} ${id}`,
		slug: `${type}-${id.toLowerCase()}`,
		type,
		status: "open",
		spec_baseline: type === "research" ? null : "B-0001",
		research_class: type === "research" ? "baseline-blocking" : null,
		depends_on: [],
		superseded_by: [],
		execution: {
			mode: type === "question-session" ? "manual" : "delegatable",
			parallel_safe: type === "research",
			conflicts_with: [],
			claim: null,
		},
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
		context_budget_exception: null,
		created_at: NOW,
		updated_at: NOW,
		...metadataOverrides,
	};
	return {
		id,
		title: metadata.title,
		slug: metadata.slug,
		type: metadata.type,
		status: metadata.status,
		execution: metadata.execution,
		path: `/storage/${id}.md`,
		digest: ticketOverrides.digest ?? SHA,
		metadata,
		...ticketOverrides,
	};
}

function claim(taskId: string) {
	return {
		executor: "dbz-crew",
		session_id: taskId,
		claim_id: `claim-${taskId}`,
		claimed_at: NOW,
	};
}

function resultSource(outcome: "done" | "blocked" | "failed" = "done"): string {
	const payload: Record<string, unknown> = {
		outcome,
		summary: "The bounded work finished.",
		deliverables: "The requested report was produced.",
		acceptance_criteria_evidence: "Every criterion has evidence.",
		validation: "Focused validation passed.",
		deviations: "None.",
		follow_ups: "None.",
		worker_commits: [],
	};
	if (outcome !== "done") payload.reason = `The worker is ${outcome}.`;
	return `DBZ-WORKFLOWS RESULT:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nDBZ-CREW RESULT: ${outcome}\n`;
}

function packet(id = "T-0001") {
	return {
		protocol_version: 1,
		workflow_id: workflow.id,
		ticket_id: id,
		ticket_digest: SHA,
		session_name: `DBZ ${workflow.id}/${id}`,
		content: [
			"# DBZ Workflows Ticket Execution Packet",
			"Submit exactly one normalized `done`, `blocked`, or `failed` result with `dbz_workflows_submit_result`. An executor cannot accept or complete its own ticket.",
			"The Ticket block is the reviewed pre-claim snapshot (digest). Dispatch binds the durable claim to this session and changes canonical status to in-progress.",
			"## Ticket",
			"Bounded ticket body.",
		].join("\n"),
		execution_environment: { cwd: "/project", mutates_project: false, branch: null, worktree: null },
		references: { spec_sections: [], decisions: [], tickets: [], files: [], repository_files_deferred: true },
		artifacts: [],
		context_budget: {},
	} as any;
}

function makeHarness() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const bus = new Map<string, Array<(value: unknown) => unknown>>();
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (value: unknown) => unknown) {
				bus.set(name, [...(bus.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, value: unknown) {
				for (const handler of bus.get(name) ?? []) handler(value);
			},
		},
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	};
	return { pi, tools, handlers, bus };
}

function makeContext(confirmValues: boolean[] = []) {
	const notifications: Array<{ message: string; level: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	return {
		notifications,
		confirmations,
		ctx: {
			cwd: "/project",
			mode: "tui",
			hasUI: true,
			model: { contextWindow: 128_000, provider: "openai-codex", id: "gpt-test" },
			thinkingLevel: "high",
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "principal-session" },
			ui: {
				notify(message: string, level: string) { notifications.push({ message, level }); },
				async confirm(title: string, message: string) {
					confirmations.push({ title, message });
					return confirmValues.shift() ?? false;
				},
			},
		},
	};
}

function existingCliPath(): string {
	return new URL("../../../../skills/dbz-crew/scripts/dbz-crew", import.meta.url).pathname;
}

test("Crew execution prompts remove manual canonical mutation instructions and require bounded structured results", () => {
	const prompt = buildCrewExecutionPrompt(packet());
	assert.doesNotMatch(prompt, /with `dbz_workflows_submit_result`/u);
	assert.match(prompt, /coordinator alone mutates canonical workflow state/u);
	assert.match(prompt, /DBZ-WORKFLOWS RESULT:/u);
	assert.match(prompt, /DBZ-CREW RESULT: <done \| blocked \| failed>/u);
	assert.ok(Buffer.byteLength(prompt, "utf8") < 50 * 1024);
	assert.match(createCrewTaskId("WF-0001", "T-0001", "fixed"), /^dbzw-[a-f0-9]{19}$/u);
});

test("Crew results normalize done, blocked, and malformed worker output to safe protocol outcomes", () => {
	const taskId = createCrewTaskId("WF-0001", "T-0001", "results");
	const selected = ticket("T-0001");
	const activeClaim = claim(taskId);
	const done = normalizeCrewExecutorResult({ eventStatus: "done", source: resultSource("done"), ticket: selected, claim: activeClaim });
	assert.equal(done.outcome, "done");
	assert.equal(done.claim.session_id, taskId);

	const blocked = normalizeCrewExecutorResult({ eventStatus: "blocked", source: "worker stopped before final JSON", ticket: selected, claim: activeClaim });
	assert.equal(blocked.outcome, "blocked");
	assert.match(blocked.reason ?? "", /normalization failed/u);

	const failed = normalizeCrewExecutorResult({ eventStatus: "done", source: "malformed output", ticket: selected, claim: activeClaim });
	assert.equal(failed.outcome, "failed");
	assert.match(failed.validation, /missing the fenced/u);

	const oversized = normalizeCrewExecutorResult({
		eventStatus: "done",
		source: "x".repeat(51 * 1024),
		ticket: selected,
		claim: activeClaim,
	});
	assert.equal(oversized.outcome, "failed");
	assert.match(oversized.validation, /50 KB/u);
});

test("explicit research waves dispatch through Crew in parallel up to the confirmed scheduler limit", async () => {
	const harness = makeHarness();
	const first = ticket("T-0001", "research", { digest: "1".repeat(64) });
	const second = ticket("T-0002", "research", { digest: "2".repeat(64) });
	const commands: string[][] = [];
	const claimed: string[] = [];
	const registered = registerDbzCrewExecutor(harness.pi as any, {
		cliPath: existingCliPath(),
		fileMutationQueue: (async (_path: string, callback: () => Promise<any>) => callback()) as any,
		commandRunner: async (args) => {
			commands.push(args);
			if (args[0] === "preflight") return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
			return { code: 0, stdout: JSON.stringify({ task_id: args[args.indexOf("--task-id") + 1] }), stderr: "" };
		},
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveWorkflowArtifactContext: async () => ({ storage: { mode: "managed" } }) as any,
			inspectWorkflow: async () => workflow as any,
			listTickets: async () => [first, second] as any,
			planSchedulerWave: async () => ({
				workflow_id: workflow.id,
				max_concurrency: 2,
				ticket_ids: [first.id, second.id],
				parallel: true,
				tickets: [
					{ id: first.id, digest: first.digest, type: first.type },
					{ id: second.id, digest: second.digest, type: second.type },
				],
			}) as any,
			assertCleanWorktree: async () => ({ headBranch: workflow.metadata.git.workflow_branch }) as any,
			buildTicketContextPacket: async (_identity, _workflow, id) => packet(id),
			randomId: (() => { let value = 0; return () => `nonce-${++value}`; })(),
			claimTicket: async (_identity, _workflow, id, options) => {
				claimed.push(id);
				const source = id === first.id ? first : second;
				const activeClaim = claim(options.sessionId);
				return {
					claim: activeClaim,
					ticket: {
						...source,
						status: "in-progress",
						digest: createCrewTaskId(workflow.id, id, "claimed").padEnd(64, "a").slice(0, 64),
						execution: { ...source.execution, claim: activeClaim },
						metadata: { ...source.metadata, status: "in-progress", execution: { ...source.execution, claim: activeClaim } },
					},
				} as any;
			},
		},
	});
	assert.equal(registered, true);
	const view = makeContext([true]);
	const result = await harness.tools.get(DBZ_CREW_TOOL_NAME).execute(
		"call",
		{ action: "dispatch", workflow_id: workflow.id, ticket_ids: [first.id, second.id], max_concurrency: 2 },
		undefined,
		undefined,
		view.ctx,
	);
	assert.deepEqual(claimed, [first.id, second.id]);
	assert.equal(commands.filter(([command]) => command === "dispatch").length, 2);
	for (const command of commands.filter(([name]) => name === "dispatch")) {
		assert.ok(command.includes("--parallel"));
		assert.ok(command.includes("--workflow-adapter"));
		assert.ok(command.includes("--read-only"));
		assert.deepEqual(
			command.slice(command.indexOf("--principal-session-id"), command.indexOf("--principal-session-id") + 2),
			["--principal-session-id", "principal-session"],
		);
		assert.ok(command.includes("--worker-provider"));
		assert.ok(command.includes("--worker-model"));
		assert.ok(command.includes("--worker-thinking"));
		assert.match(command[command.indexOf("--prompt") + 1], /coordinator alone mutates canonical/u);
	}
	assert.match(view.confirmations[0]?.message ?? "", /Confirmed concurrency limit: 2/u);
	assert.match(result.content[0].text, /"dispatched": true/u);
});

test("project storage retains confirmed claims for explicit resume before code dispatch", async () => {
	const harness = makeHarness();
	const implementation = ticket("T-0004", "implementation", {
		digest: "4".repeat(64),
		metadata: {
			execution: { mode: "delegatable", parallel_safe: false, conflicts_with: [], claim: null },
		},
	});
	const commands: string[][] = [];
	let statusChecks = 0;
	registerDbzCrewExecutor(harness.pi as any, {
		cliPath: existingCliPath(),
		fileMutationQueue: (async (_path: string, callback: () => Promise<any>) => callback()) as any,
		commandRunner: async (args) => {
			commands.push(args);
			return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
		},
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveWorkflowArtifactContext: async () => ({ storage: { mode: "project" } }) as any,
			inspectWorkflow: async () => workflow as any,
			listTickets: async () => [implementation] as any,
			planSchedulerWave: async () => ({
				workflow_id: workflow.id,
				max_concurrency: 1,
				ticket_ids: [implementation.id],
				parallel: false,
				tickets: [{ id: implementation.id, digest: implementation.digest }],
			}) as any,
			assertCleanWorktree: async () => {
				statusChecks += 1;
				if (statusChecks > 1) throw new Error("canonical claim change is uncommitted");
				return { headBranch: workflow.metadata.git.workflow_branch } as any;
			},
			listGitWorktrees: async () => [{ path: "/project.dbz-ticket-WF-0001-T-0004-implementation-t-0004" }] as any,
			inspectTicketWorktree: async () => ({ status: { clean: true } }) as any,
			buildTicketContextPacket: async () => ({
				...packet(implementation.id),
				execution_environment: {
					cwd: "/project.dbz-ticket-WF-0001-T-0004-implementation-t-0004",
					mutates_project: true,
					branch: "dbz-tickets/WF-0001/T-0004-implementation-t-0004",
					worktree: "/project.dbz-ticket-WF-0001-T-0004-implementation-t-0004",
				},
			}) as any,
			claimTicket: async (_identity, _workflow, _ticket, options) => {
				const activeClaim = claim(options.sessionId);
				return {
					claim: activeClaim,
					ticket: {
						...implementation,
						status: "in-progress",
						execution: { ...implementation.execution, claim: activeClaim },
					},
				} as any;
			},
		},
	});
	const view = makeContext([true]);
	const result = await harness.tools.get(DBZ_CREW_TOOL_NAME).execute(
		"call",
		{ action: "dispatch", workflow_id: workflow.id, ticket_ids: [implementation.id] },
		undefined,
		undefined,
		view.ctx,
	);
	assert.equal(commands.filter(([name]) => name === "dispatch").length, 0);
	assert.match(result.content[0].text, /canonical_commit_required/u);
	assert.match(result.content[0].text, /Claims never expire automatically/u);
});

test("question sessions are rejected before any Crew worker dispatch", async () => {
	const harness = makeHarness();
	const question = ticket("T-0001", "question-session");
	const commands: string[][] = [];
	registerDbzCrewExecutor(harness.pi as any, {
		cliPath: existingCliPath(),
		commandRunner: async (args) => {
			commands.push(args);
			return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
		},
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveWorkflowArtifactContext: async () => ({ storage: { mode: "managed" } }) as any,
			inspectWorkflow: async () => workflow as any,
			listTickets: async () => [question] as any,
			planSchedulerWave: async () => ({ max_concurrency: 1, ticket_ids: [question.id] }) as any,
		},
	});
	const view = makeContext([true]);
	await assert.rejects(
		harness.tools.get(DBZ_CREW_TOOL_NAME).execute(
			"call",
			{ action: "dispatch", workflow_id: workflow.id, ticket_ids: [question.id] },
			undefined,
			undefined,
			view.ctx,
		),
		/interactive-only.*cannot be dispatched/u,
	);
	assert.equal(commands.filter(([command]) => command === "dispatch").length, 0);
});

test("mutating Crew results release the worker before coordinator-owned reconciliation and integration", async () => {
	const harness = makeHarness();
	const taskId = createCrewTaskId(workflow.id, "T-0003", "integrate");
	const activeClaim = claim(taskId);
	const implementation = ticket("T-0003", "implementation", {
		status: "in-progress",
		metadata: {
			status: "in-progress",
			execution: {
				mode: "delegatable",
				parallel_safe: true,
				conflicts_with: [],
				claim: activeClaim,
				result: { outcome: "done", claim: activeClaim },
			},
		},
	});
	implementation.execution = implementation.metadata.execution;
	const commands: string[][] = [];
	let integrated = false;
	registerDbzCrewExecutor(harness.pi as any, {
		cliPath: existingCliPath(),
		commandRunner: async (args) => {
			commands.push(args);
			return { code: 0, stdout: JSON.stringify({ released: true }), stderr: "" };
		},
		dependencies: {
			inspectGitProject: async () => identity as any,
			inspectTicket: async () => implementation as any,
			inspectWorkflow: async () => workflow as any,
			integrateMutatingTicketResult: async () => {
				integrated = true;
				return { action: "integrated", integrated_commits: ["b".repeat(40)], worktree_removed: true } as any;
			},
		},
	});
	const view = makeContext([true]);
	const result = await harness.tools.get(DBZ_CREW_TOOL_NAME).execute(
		"call",
		{ action: "integrate", workflow_id: workflow.id, ticket_ids: [implementation.id] },
		undefined,
		undefined,
		view.ctx,
	);
	assert.deepEqual(commands, [["release", "--task-id", taskId]]);
	assert.equal(integrated, true);
	assert.match(result.content[0].text, /"action": "integrated"/u);
});

test("completion events are normalized and applied only by the coordinator adapter", async () => {
	const harness = makeHarness();
	const taskId = createCrewTaskId(workflow.id, "T-0001", "event");
	const activeClaim = claim(taskId);
	const selected = ticket("T-0001", "research", {
		status: "in-progress",
		metadata: {
			status: "in-progress",
			execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim: activeClaim },
		},
	});
	selected.execution = selected.metadata.execution;
	let applied: any;
	let applyOptions: any;
	const queued: string[] = [];
	registerDbzCrewExecutor(harness.pi as any, {
		cliPath: existingCliPath(),
		fileMutationQueue: (async (path: string, callback: () => Promise<any>) => {
			queued.push(path);
			return callback();
		}) as any,
		dependencies: {
			inspectGitProject: async () => identity as any,
			listWorkflows: async () => [workflow] as any,
			listTickets: async () => [selected] as any,
			readCrewResult: async () => resultSource("done"),
			applyExecutorResult: async (_identity, _workflow, _ticket, result, options) => {
				applied = result;
				applyOptions = options;
				return { ticket: { status: "in-progress" }, claim_released: false } as any;
			},
		},
	});
	const view = makeContext();
	for (const handler of harness.handlers.get("session_start") ?? []) await handler({}, view.ctx);
	harness.pi.events.emit(CREW_COMPLETION_EVENT_CHANNEL, {
		id: "event-1",
		principal_session_id: "principal-session",
		task_id: taskId,
		phase: "implementation",
		status: "done",
		result: "/private/result.md",
		created_at: Date.now(),
	});
	for (let index = 0; index < 100 && applied === undefined; index += 1) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
	assert.equal(applied.outcome, "done");
	assert.equal(applied.claim.session_id, taskId);
	assert.equal(applyOptions.failedDisposition, undefined);
	assert.deepEqual(queued, [selected.path]);
	assert.match(view.notifications[0]?.message ?? "", /worker did not complete the ticket/u);
});

test("the optional adapter does not register when the cohesive DBZ Crew CLI resource is absent", () => {
	const harness = makeHarness();
	assert.equal(crewAdapterResourceAvailable("/definitely/missing/dbz-crew"), false);
	assert.equal(registerDbzCrewExecutor(harness.pi as any, { cliPath: "/definitely/missing/dbz-crew" }), false);
	assert.equal(harness.tools.size, 0);
	assert.equal(harness.bus.size, 0);
});
