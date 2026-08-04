import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import {
	applyTicketWorktreePlan,
	createTicketWorktreePlan,
} from "../../../../skills/dbz-workflows/lib/git-plans.mjs";
import {
	ticketBranchName,
	workflowBranchName,
} from "../../../../skills/dbz-workflows/lib/git-operations.mjs";
import {
	assembleTicketContextPacket,
	buildTicketContextPacket,
} from "./context.ts";
import {
	createCurrentSessionExecutorResult,
	prepareCoordinatorAcceptance,
	submittedResultResponse,
} from "./results.ts";
import {
	currentTicketSessionLocator,
	defaultTicketWorktreePath,
	formatReviewedGitPlan,
	integrateMutatingTicketResult,
	returnToCoordinationSession,
	runOrResumeTicketSession,
	TICKET_SESSION_LOCATOR_ENTRY,
	type TicketSessionLocator,
} from "./sessions.ts";

const execFileAsync = promisify(execFile);
const SHA = "a".repeat(64);
const NOW = "2026-08-03T15:30:00.000Z";
const WORKFLOW_ID = "WF-0001";
const WORKFLOW_SLUG = "example-workflow";
const TICKET_ID = "T-0001";
const TICKET_SLUG = "implement-feature";
const identity = {
	projectRoot: "/project",
	projectKey: `git-sha1-${"a".repeat(40)}`,
	objectFormat: "sha1",
	rootCommit: "a".repeat(40),
};

function metadata(overrides: Record<string, any> = {}) {
	return {
		artifact: "ticket",
		schema_version: 1,
		id: TICKET_ID,
		workflow_id: WORKFLOW_ID,
		title: "Research one thing",
		slug: "research-one-thing",
		type: "research",
		status: "open",
		spec_baseline: null,
		research_class: "baseline-blocking",
		depends_on: [],
		superseded_by: [],
		execution: {
			mode: "delegatable",
			parallel_safe: true,
			conflicts_with: [],
			claim: null,
		},
		context: {
			spec_sections: ["Scope"],
			decisions: ["D-0001"],
			tickets: ["T-0002"],
			files: ["src/declared.ts"],
		},
		context_budget_exception: null,
		created_at: NOW,
		updated_at: NOW,
		...overrides,
	};
}

function inspectedTicket(overrides: Record<string, any> = {}) {
	const baseMetadata = metadata(overrides.metadata);
	return {
		id: baseMetadata.id,
		title: baseMetadata.title,
		slug: baseMetadata.slug,
		type: baseMetadata.type,
		status: baseMetadata.status,
		path: "/storage/WF-0001/tickets/T-0001.md",
		digest: SHA,
		execution: baseMetadata.execution,
		context_budget_exception: baseMetadata.context_budget_exception,
		metadata: baseMetadata,
		...overrides,
	};
}

function workflow(overrides: Record<string, any> = {}) {
	return {
		id: WORKFLOW_ID,
		title: "Example workflow",
		slug: WORKFLOW_SLUG,
		metadata: {
			git: { workflow_branch: workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG) },
		},
		...overrides,
	};
}

const ticketSource = `---\nartifact: ticket\n---\n# Research one thing\n\n## Objective\nDo the ticket.\n\n## Result\n`;

function packetFor(ticket = inspectedTicket(), executionEnvironment?: any) {
	return assembleTicketContextPacket({
		workflowId: WORKFLOW_ID,
		ticket,
		ticketSource,
		segments: [
			{
				kind: "spec_section",
				id: "Scope",
				content: "## Scope\nOnly declared scope.\n",
				path: "/storage/WF-0001/spec.md",
				digest: "b".repeat(64),
			},
			{
				kind: "decision",
				id: "D-0001",
				content: "---\nartifact: decision\n---\n# Decision\n\n## Decision\nUse A.\n",
				path: "/storage/WF-0001/decisions/D-0001-a.md",
				digest: "c".repeat(64),
			},
			{
				kind: "ticket_result",
				id: "T-0002",
				content: "## Result\n\n### Summary\nReusable evidence only.\n",
				path: "/storage/WF-0001/tickets/T-0002.md",
				digest: "d".repeat(64),
			},
		],
		contextWindowTokens: 128_000,
		executionEnvironment,
	});
}

function makeUi(confirmValues: boolean[] = []) {
	const notifications: Array<{ message: string; level: string }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	return {
		notifications,
		confirms,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async confirm(title: string, message: string) {
				confirms.push({ title, message });
				return confirmValues.shift() ?? false;
			},
		},
	};
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function withRepository(run: (value: { directory: string; repository: string; sessions: string }) => Promise<void>) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-session-test-"));
	const repository = resolve(directory, "project");
	const sessions = resolve(directory, "sessions");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "workflows-test@example.invalid");
		await writeFile(resolve(repository, "tracked.txt"), "initial\n");
		await git(repository, "add", "tracked.txt");
		await git(repository, "commit", "--quiet", "-m", "initial");
		await git(repository, "switch", "-c", workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG));
		await run({ directory, repository, sessions });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function authorization(plan: any) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

function mutatingTicket(overrides: Record<string, any> = {}) {
	const claim = overrides.claim ?? null;
	const result = overrides.result;
	const status = overrides.status ?? "open";
	const ticketMetadata = metadata({
		title: "Implement feature",
		slug: TICKET_SLUG,
		type: "implementation",
		status,
		spec_baseline: "B-0001",
		research_class: null,
		execution: {
			mode: "delegatable",
			parallel_safe: false,
			conflicts_with: [],
			claim,
			...(result === undefined ? {} : { result }),
		},
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
	});
	return inspectedTicket({
		title: ticketMetadata.title,
		slug: ticketMetadata.slug,
		type: ticketMetadata.type,
		status,
		execution: ticketMetadata.execution,
		metadata: ticketMetadata,
	});
}

function packetBuilder(ticket: any) {
	return async (_identity: any, _workflowId: string, _ticketId: string, options: any) => assembleTicketContextPacket({
		workflowId: WORKFLOW_ID,
		ticket,
		ticketSource: `---\nartifact: ticket\n---\n# Implement feature\n\n## Objective\nImplement.\n\n## Result\n`,
		segments: [],
		contextWindowTokens: 128_000,
		executionEnvironment: options.executionEnvironment,
	});
}

function coordinatorContext(repository: string, sessions: string, confirms: boolean[], transcript = "OLD-TRANSCRIPT") {
	const view = makeUi(confirms);
	return {
		view,
		ctx: {
			cwd: repository,
			ui: view.ui,
			model: { contextWindow: 128_000 },
			sessionManager: {
				getSessionId: () => "coordinator-session",
				getSessionFile: () => resolve(sessions, "coordinator.jsonl"),
				getSessionDir: () => sessions,
				getBranch: () => [{ type: "message", message: { content: transcript } }],
			},
			waitForIdle: async () => {},
		},
	};
}

test("context packets contain only declared artifact content and defer repository file bodies", () => {
	const packet = packetFor();
	assert.match(packet.content, /Only declared scope/u);
	assert.match(packet.content, /Use A\./u);
	assert.match(packet.content, /Reusable evidence only/u);
	assert.match(packet.content, /src\/declared\.ts.*path only/u);
	assert.doesNotMatch(packet.content, /Undeclared Security Section/u);
	assert.equal(packet.references.repository_files_deferred, true);
	assert.equal(packet.context_budget.within_budget, true);
	assert.deepEqual(packet.artifacts.map(({ kind, id }) => `${kind}:${id}`), [
		"ticket:T-0001",
		"spec_section:Scope",
		"decision:D-0001",
		"ticket_result:T-0002",
	]);
});

test("rendered context packets require an explicit exception when they exceed the active-model budget", () => {
	assert.throws(
		() => assembleTicketContextPacket({
			workflowId: WORKFLOW_ID,
			ticket: inspectedTicket({
				metadata: metadata({ context: { spec_sections: [], decisions: [], tickets: [], files: [] } }),
				context_budget_exception: null,
			}),
			ticketSource,
			segments: [],
			contextWindowTokens: 1_000,
		}),
		/exceeding the 250-token budget/u,
	);
	const exception = {
		justification: "Atomic ticket packet approved despite the small test model",
		approved_by: "user",
		approved_at: NOW,
	};
	const exceptedMetadata = metadata({
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
		context_budget_exception: exception,
	});
	const packet = assembleTicketContextPacket({
		workflowId: WORKFLOW_ID,
		ticket: inspectedTicket({ metadata: exceptedMetadata, context_budget_exception: exception }),
		ticketSource,
		segments: [],
		contextWindowTokens: 1_000,
	});
	assert.equal(packet.context_budget.within_budget, false);
	assert.equal(packet.context_budget.exception_applied, true);
});

test("packet construction reads only declared spec sections, decisions, and ticket Result sections", async () => {
	const sources = new Map([
		["/ticket.md", `${ticketSource}\n`],
		["/spec.md", "---\nartifact: spec\n---\n# Spec\n\n## Scope\nDeclared.\n\n## Security\nSECRET-UNDECLARED\n"],
		["/decision.md", "---\nartifact: decision\n---\n# Decision\n\n## Decision\nChosen.\n"],
		["/referenced.md", "---\nartifact: ticket\n---\n# Other\n\n## Objective\nOBJECTIVE-UNDECLARED\n\n## Result\nRESULT-DECLARED\n"],
	]);
	const digests = new Map([...sources.keys()].map((path, index) => [path, String(index + 1).repeat(64)]));
	const ticket = inspectedTicket({ path: "/ticket.md", digest: digests.get("/ticket.md") });
	const packet = await buildTicketContextPacket(identity, WORKFLOW_ID, TICKET_ID, {
		contextWindowTokens: 128_000,
		dependencies: {
			inspectTicket: async (_identity, _workflow, id) => id === TICKET_ID
				? ticket as any
				: ({ id, path: "/referenced.md", digest: digests.get("/referenced.md") }) as any,
			inspectSpec: async () => ({ path: "/spec.md", digest: digests.get("/spec.md") }) as any,
			inspectDecision: async () => ({ id: "D-0001", path: "/decision.md", digest: digests.get("/decision.md") }) as any,
			readFileWithDigest: async (path) => ({ data: sources.get(path), digest: digests.get(path) }) as any,
		},
	});
	assert.match(packet.content, /Declared\./u);
	assert.match(packet.content, /Chosen\./u);
	assert.match(packet.content, /RESULT-DECLARED/u);
	assert.doesNotMatch(packet.content, /SECRET-UNDECLARED/u);
	assert.doesNotMatch(packet.content, /OBJECTIVE-UNDECLARED/u);
});

test("mutating dispatch applies the complete reviewed ticket-worktree plan and opens a fresh cross-cwd session", async () => {
	await withRepository(async ({ repository, sessions }) => {
		const gitIdentity = await inspectGitProject(repository);
		const selectedWorkflow = workflow();
		const selectedTicket = mutatingTicket();
		const coordinatorHead = await git(repository, "rev-parse", "HEAD");
		const coordinatorBranch = await git(repository, "branch", "--show-current");
		const { ctx, view } = coordinatorContext(repository, sessions, [true, true], "OLD-TRANSCRIPT-MUST-NOT-COPY");
		let openedManager: SessionManager | undefined;
		let replacementCwd = "";
		let packet = "";
		(ctx as any).switchSession = async (path: string, options: any) => {
			openedManager = SessionManager.open(path);
			replacementCwd = openedManager.getCwd();
			assert.equal(openedManager.getEntries().some((entry) => entry.type === "message"), false);
			assert.equal(openedManager.getHeader()?.parentSession, undefined);
			await options.withSession({
				cwd: replacementCwd,
				ui: { notify() {} },
				async sendUserMessage(value: string) { packet = value; },
			});
			return { cancelled: false };
		};
		const result = await runOrResumeTicketSession(ctx as any, gitIdentity, selectedWorkflow, selectedTicket, {
			plannedTicketDigest: selectedTicket.digest,
			contextWindowTokens: 128_000,
			dependencies: {
				inspectWorkflow: async () => selectedWorkflow as any,
				inspectTicket: async () => selectedTicket as any,
				buildTicketContextPacket: packetBuilder(selectedTicket) as any,
				startManualExecution: async (_identity, _workflow, _ticket, options) => ({
					claim: { claim_id: "claim-1", session_id: options.sessionId },
				}) as any,
			},
		});
		const worktree = defaultTicketWorktreePath(repository, WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
		const branch = ticketBranchName(WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
		assert.equal(result.action, "created");
		assert.equal(replacementCwd, worktree);
		assert.equal(await git(worktree, "branch", "--show-current"), branch);
		assert.equal(await git(repository, "branch", "--show-current"), coordinatorBranch);
		assert.equal(await git(repository, "rev-parse", "HEAD"), coordinatorHead);
		assert.equal(await git(repository, "status", "--porcelain"), "");
		assert.equal(packet.includes(`Runtime cwd: \`${worktree}\``), true);
		assert.equal(packet.includes(branch), true);
		assert.doesNotMatch(packet, /OLD-TRANSCRIPT-MUST-NOT-COPY/u);
		assert.equal(view.confirms[0].message.startsWith("Complete reviewed Git plan:\n{"), true);
		assert.match(view.confirms[0].message, /"operation": "git_ticket_worktree"/u);
		assert.ok(openedManager);
		const locator = currentTicketSessionLocator(openedManager as any);
		assert.equal(locator?.ticket_branch, branch);
		assert.equal(locator?.ticket_worktree, worktree);
	});
});

test("project-mode canonical claim changes pause mutating dispatch until the coordinator checkout is clean", async () => {
	await withRepository(async ({ repository, sessions }) => {
		const gitIdentity = await inspectGitProject(repository);
		const selectedWorkflow = workflow();
		const selectedTicket = mutatingTicket();
		const { ctx, view } = coordinatorContext(repository, sessions, [true, true]);
		let switches = 0;
		(ctx as any).switchSession = async () => {
			switches += 1;
			return { cancelled: false };
		};
		const result = await runOrResumeTicketSession(ctx as any, gitIdentity, selectedWorkflow, selectedTicket, {
			plannedTicketDigest: selectedTicket.digest,
			dependencies: {
				inspectWorkflow: async () => selectedWorkflow as any,
				inspectTicket: async () => selectedTicket as any,
				buildTicketContextPacket: packetBuilder(selectedTicket) as any,
				startManualExecution: async (_identity, _workflow, _ticket, options) => {
					await writeFile(resolve(repository, "tracked.txt"), "canonical claim changed\n");
					return { claim: { claim_id: "claim-project", session_id: options.sessionId } } as any;
				},
			},
		});
		assert.equal(result.action, "canonical_commit_required");
		assert.equal(switches, 0);
		assert.notEqual(await git(repository, "status", "--porcelain"), "");
		assert.match(view.notifications.at(-1)?.message ?? "", /commit or otherwise resolve the canonical claim change/u);
		assert.match(view.notifications.at(-1)?.message ?? "", /claim was not released/u);

		await git(repository, "add", "tracked.txt");
		await git(repository, "commit", "--quiet", "-m", "chore(dbz-workflows): record ticket claim");
		const worktree = defaultTicketWorktreePath(repository, WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
		const storedSessions = await SessionManager.list(worktree, sessions);
		assert.equal(storedSessions.length, 1);
		const storedLocator = currentTicketSessionLocator(SessionManager.open(storedSessions[0].path));
		assert.ok(storedLocator);
		const claim = {
			executor: "manual",
			session_id: storedLocator.executor_session_id,
			claim_id: storedLocator.claim_id,
			claimed_at: NOW,
		};
		const claimedTicket = mutatingTicket({ status: "in-progress", claim });
		const resumedView = makeUi([true]);
		let resumedCwd = "";
		const resumeCtx: any = {
			cwd: repository,
			ui: resumedView.ui,
			sessionManager: {
				getSessionId: () => "coordinator-session",
				getSessionFile: () => resolve(sessions, "coordinator.jsonl"),
				getSessionDir: () => sessions,
				getBranch: () => [],
			},
			switchSession: async (path: string, options: any) => {
				const manager = SessionManager.open(path);
				resumedCwd = manager.getCwd();
				await options.withSession({
					cwd: resumedCwd,
					ui: { notify() {} },
					async sendUserMessage() {},
				});
				return { cancelled: false };
			},
		};
		const resumed = await runOrResumeTicketSession(resumeCtx, gitIdentity, selectedWorkflow, claimedTicket, {
			dependencies: {
				inspectWorkflow: async () => selectedWorkflow as any,
				inspectTicket: async () => claimedTicket as any,
			},
		});
		assert.equal(resumed.action, "resumed");
		assert.equal(resumedCwd, worktree);
	});
});

test("read-only dispatch creates no ticket branch or worktree and still uses a fresh transcript-free session", async () => {
	await withRepository(async ({ repository, sessions }) => {
		const gitIdentity = await inspectGitProject(repository);
		const selectedWorkflow = workflow();
		const selectedTicket = inspectedTicket({
			metadata: metadata({ context: { spec_sections: [], decisions: [], tickets: [], files: [] } }),
		});
		const branchesBefore = await git(repository, "for-each-ref", "--format=%(refname)", "refs/heads/");
		const worktreesBefore = await git(repository, "worktree", "list", "--porcelain");
		const { ctx, view } = coordinatorContext(repository, sessions, [true], "COORDINATOR-SECRET");
		let targetManager: SessionManager | undefined;
		let sent = "";
		(ctx as any).switchSession = async (path: string, options: any) => {
			targetManager = SessionManager.open(path);
			await options.withSession({
				cwd: targetManager.getCwd(),
				ui: { notify() {} },
				async sendUserMessage(value: string) { sent = value; },
			});
			return { cancelled: false };
		};
		await runOrResumeTicketSession(ctx as any, gitIdentity, selectedWorkflow, selectedTicket, {
			plannedTicketDigest: selectedTicket.digest,
			dependencies: {
				inspectWorkflow: async () => selectedWorkflow as any,
				inspectTicket: async () => selectedTicket as any,
				buildTicketContextPacket: async (_identity, _workflow, _ticket, options) => assembleTicketContextPacket({
					workflowId: WORKFLOW_ID,
					ticket: selectedTicket,
					ticketSource,
					segments: [],
					contextWindowTokens: 128_000,
					executionEnvironment: options.executionEnvironment,
				}),
				startManualExecution: async (_identity, _workflow, _ticket, options) => ({
					claim: { claim_id: "claim-read", session_id: options.sessionId },
				}) as any,
			},
		});
		assert.equal(view.confirms.length, 1);
		assert.equal(targetManager?.getCwd(), repository);
		assert.equal(targetManager?.getEntries().some((entry) => entry.type === "message"), false);
		assert.equal(await git(repository, "for-each-ref", "--format=%(refname)", "refs/heads/"), branchesBefore);
		assert.equal(await git(repository, "worktree", "list", "--porcelain"), worktreesBefore);
		assert.match(sent, /Project mutation: prohibited/u);
		assert.doesNotMatch(sent, /COORDINATOR-SECRET/u);
	});
});

test("a missing claimed session is not released without explicit recovery confirmation", async () => {
	const claim = { executor: "manual", session_id: "missing-session", claim_id: "claim-missing", claimed_at: NOW };
	const claimedMetadata = metadata({
		status: "in-progress",
		execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim },
	});
	const ticket = inspectedTicket({ status: "in-progress", execution: claimedMetadata.execution, metadata: claimedMetadata });
	const view = makeUi([false]);
	let recoveries = 0;
	const ctx: any = {
		cwd: "/project",
		ui: view.ui,
		sessionManager: {
			getSessionId: () => "coordinator",
			getSessionFile: () => "/sessions/coordinator.jsonl",
			getSessionDir: () => "/sessions",
			getBranch: () => [],
		},
	};
	const result = await runOrResumeTicketSession(ctx, identity, workflow(), ticket, {
		dependencies: {
			inspectWorkflow: async () => workflow() as any,
			inspectTicket: async () => ticket as any,
			listSessions: async () => [],
			recoverTicketClaim: async () => { recoveries += 1; return {} as any; },
		},
	});
	assert.equal(result.action, "recovery_cancelled");
	assert.equal(recoveries, 0);
	assert.match(view.confirms[0].message, /Claims never expire automatically/u);
	assert.match(view.notifications[0].message, /claim remains active/u);
});

test("confirmed missing-session recovery is tied to the exact claim and replacement dispatch remains explicit", async () => {
	const claim = { executor: "manual", session_id: "missing-session", claim_id: "claim-missing", claimed_at: NOW };
	const claimedMetadata = metadata({
		status: "in-progress",
		execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim },
	});
	const claimedTicket = inspectedTicket({ status: "in-progress", execution: claimedMetadata.execution, metadata: claimedMetadata });
	const recoveredMetadata = metadata({
		status: "open",
		execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim: null },
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
	});
	const recoveredTicket = inspectedTicket({ status: "open", execution: recoveredMetadata.execution, metadata: recoveredMetadata });
	const view = makeUi([true, false]);
	let recoveryOptions: any;
	const ctx: any = {
		cwd: "/project",
		ui: view.ui,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionId: () => "coordinator",
			getSessionFile: () => "/sessions/coordinator.jsonl",
			getSessionDir: () => "/sessions",
			getBranch: () => [],
		},
	};
	const result = await runOrResumeTicketSession(ctx, identity, workflow(), claimedTicket, {
		dependencies: {
			inspectWorkflow: async () => workflow() as any,
			inspectTicket: async () => claimedTicket as any,
			listSessions: async () => [],
			recoverTicketClaim: async (_identity, _workflow, _ticket, options) => {
				recoveryOptions = options;
				return { ticket: recoveredTicket } as any;
			},
			buildTicketContextPacket: async (_identity, _workflow, _ticket, options) => assembleTicketContextPacket({
				workflowId: WORKFLOW_ID,
				ticket: recoveredTicket,
				ticketSource,
				segments: [],
				contextWindowTokens: 128_000,
				executionEnvironment: options.executionEnvironment,
			}),
		},
	});
	assert.equal(result.action, "cancelled");
	assert.deepEqual(recoveryOptions.authorization, {
		confirmed: true,
		recovered_by: "user",
		claim_id: "claim-missing",
	});
	assert.match(recoveryOptions.rationale, /absent from the configured session storage/u);
	assert.equal(view.confirms.length, 2);
});

function readOnlyLocator(overrides: Partial<TicketSessionLocator> = {}): TicketSessionLocator {
	return {
		version: 1,
		project_key: identity.projectKey,
		workflow_id: WORKFLOW_ID,
		workflow_slug: WORKFLOW_SLUG,
		ticket_id: TICKET_ID,
		ticket_slug: "research-one-thing",
		claim_id: "claim-1",
		executor_session_id: "executor-session",
		executor_cwd: "/project",
		mutates_project: false,
		ticket_branch: null,
		ticket_worktree: null,
		coordinator_session_id: "coordinator-session",
		coordinator_session_file: "/sessions/coordinator.jsonl",
		coordinator_cwd: "/project",
		...overrides,
	};
}

test("an existing claimed ticket resumes by validated session ID, cwd, and locator without changing its claim", async () => {
	const claim = { executor: "manual", session_id: "executor-session", claim_id: "claim-1", claimed_at: NOW };
	const claimedMetadata = metadata({
		status: "in-progress",
		execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim },
	});
	const ticket = inspectedTicket({ status: "in-progress", execution: claimedMetadata.execution, metadata: claimedMetadata });
	const view = makeUi([true]);
	let resumedPrompt = "";
	let recoveries = 0;
	const ctx: any = {
		cwd: "/project",
		ui: view.ui,
		sessionManager: {
			getSessionId: () => "coordinator-session",
			getSessionFile: () => "/sessions/coordinator.jsonl",
			getSessionDir: () => "/sessions",
			getBranch: () => [],
		},
		switchSession: async (path: string, options: any) => {
			assert.equal(path, "/sessions/executor.jsonl");
			await options.withSession({
				cwd: "/project",
				ui: { notify() {} },
				async sendUserMessage(value: string) { resumedPrompt = value; },
			});
			return { cancelled: false };
		},
	};
	const locator = readOnlyLocator();
	const result = await runOrResumeTicketSession(ctx, identity, workflow(), ticket, {
		dependencies: {
			inspectWorkflow: async () => workflow() as any,
			inspectTicket: async () => ticket as any,
			listSessions: async () => [{ id: "executor-session", path: "/sessions/executor.jsonl", cwd: "/project" }] as any,
			openSession: () => ({ getBranch: () => [{ type: "custom", customType: TICKET_SESSION_LOCATOR_ENTRY, data: locator }] }) as any,
			recoverTicketClaim: async () => { recoveries += 1; return {} as any; },
		},
	});
	assert.equal(result.action, "resumed");
	assert.equal(recoveries, 0);
	assert.match(resumedPrompt, /Resume only WF-0001\/T-0001 in cwd \/project/u);
});

test("submitted results return through the exact coordinator locator using only a fresh replacement context", async () => {
	const locator = readOnlyLocator();
	const resultMetadata = { outcome: "done", claim: { claim_id: "claim-1", session_id: "executor-session" } };
	const ticket = inspectedTicket({
		status: "in-progress",
		execution: { claim: { session_id: "executor-session" }, result: resultMetadata },
		metadata: metadata({ execution: { claim: { session_id: "executor-session" }, result: resultMetadata } }),
	});
	const view = makeUi([true]);
	let stale = false;
	let handoff = "";
	const manager: any = {
		getSessionId: () => "executor-session",
		getSessionFile: () => "/sessions/executor.jsonl",
		getSessionDir: () => "/sessions",
		getBranch: () => [{ type: "custom", customType: TICKET_SESSION_LOCATOR_ENTRY, data: locator }],
	};
	assert.deepEqual(currentTicketSessionLocator(manager), locator);
	const ctx: any = {
		cwd: "/project",
		sessionManager: manager,
		ui: {
			...view.ui,
			notify(...args: any[]) {
				if (stale) throw new Error("stale old UI used");
				(view.ui.notify as any)(...args);
			},
		},
		switchSession: async (path: string, options: any) => {
			assert.equal(path, locator.coordinator_session_file);
			stale = true;
			await options.withSession({
				cwd: "/project",
				sessionManager: { getSessionId: () => "coordinator-session" },
				ui: { notify() {} },
				async sendUserMessage(value: string) { handoff = value; },
			});
			return { cancelled: false };
		},
	};
	const returned = await returnToCoordinationSession(ctx, undefined, WORKFLOW_ID, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			inspectWorkflow: async () => workflow() as any,
			inspectTicket: async () => ticket as any,
			listSessions: async () => [{
				id: "coordinator-session",
				path: "/sessions/coordinator.jsonl",
				cwd: "/project",
			}] as any,
		},
	});
	assert.equal(returned.action, "returned");
	assert.match(handoff, /Inspect the ticket Result.*canonical artifacts/u);
	assert.match(handoff, /do not depend on the executor transcript/u);
});

test("missing coordinator recovery creates a fresh coordinator-cwd session without either transcript", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-coordinator-recovery-test-"));
	try {
		const coordinatorCwd = resolve(directory, "coordinator");
		const executorCwd = resolve(directory, "executor");
		await Promise.all([
			mkdir(coordinatorCwd),
			mkdir(executorCwd),
		]);
		const locator = readOnlyLocator({
			executor_cwd: executorCwd,
			coordinator_cwd: coordinatorCwd,
			coordinator_session_file: resolve(directory, "sessions", "missing-coordinator.jsonl"),
		});
		const resultMetadata = { outcome: "done", claim: { claim_id: "claim-1", session_id: "executor-session" } };
		const ticket = inspectedTicket({
			status: "in-progress",
			execution: { claim: { session_id: "executor-session" }, result: resultMetadata },
			metadata: metadata({ execution: { claim: { session_id: "executor-session" }, result: resultMetadata } }),
		});
		const view = makeUi([true]);
		let replacement: SessionManager | undefined;
		let handoff = "";
		const ctx: any = {
			cwd: executorCwd,
			ui: view.ui,
			sessionManager: {
				getSessionId: () => "executor-session",
				getSessionFile: () => resolve(directory, "sessions", "executor.jsonl"),
				getSessionDir: () => resolve(directory, "sessions"),
				getBranch: () => [{ type: "custom", customType: TICKET_SESSION_LOCATOR_ENTRY, data: locator }],
			},
			switchSession: async (path: string, options: any) => {
				replacement = SessionManager.open(path);
				assert.equal(replacement.getCwd(), coordinatorCwd);
				assert.equal(replacement.getEntries().some((entry) => entry.type === "message"), false);
				assert.equal(replacement.getHeader()?.parentSession, undefined);
				await options.withSession({
					cwd: coordinatorCwd,
					sessionManager: { getSessionId: () => replacement?.getSessionId() },
					ui: { notify() {} },
					async sendUserMessage(value: string) { handoff = value; },
				});
				return { cancelled: false };
			},
		};
		const returned = await returnToCoordinationSession(ctx, undefined, WORKFLOW_ID, {
			dependencies: {
				inspectGitProject: async () => ({ ...identity, projectRoot: coordinatorCwd }) as any,
				inspectWorkflow: async () => workflow() as any,
				inspectTicket: async () => ticket as any,
				listSessions: async () => [],
			},
		});
		assert.equal(returned.action, "coordinator_recovered");
		assert.ok(replacement);
		assert.match(handoff, /Continue coordination/u);
		assert.doesNotMatch(JSON.stringify(replacement?.getEntries()), /coordinator transcript|executor transcript/iu);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("coordinator integration reviews reconciliation, integration, and cleanup plans in a disposable real repository", async () => {
	await withRepository(async ({ directory, repository }) => {
		const gitIdentity = await inspectGitProject(repository);
		const selectedWorkflow = workflow();
		const worktree = defaultTicketWorktreePath(repository, WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
		const plan = await createTicketWorktreePlan({
			cwd: repository,
			worktreePath: worktree,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			ticketId: TICKET_ID,
			ticketSlug: TICKET_SLUG,
		});
		await applyTicketWorktreePlan(plan, { authorization: authorization(plan) });
		await writeFile(resolve(worktree, "feature.txt"), "implemented\n");
		await git(worktree, "add", "feature.txt");
		await git(
			worktree,
			"commit",
			"--quiet",
			"-m",
			"feat: implement feature",
			"-m",
			`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}`,
		);
		const ticketCommit = await git(worktree, "rev-parse", "HEAD");
		const claim = { executor: "manual", session_id: "executor-session", claim_id: "claim-1", claimed_at: NOW };
		const resultMetadata = { outcome: "done", claim, worker_commits: [ticketCommit] };
		const selectedTicket = mutatingTicket({ status: "in-progress", claim, result: resultMetadata });
		const view = makeUi([true, true, true]);
		const ctx: any = {
			cwd: repository,
			ui: view.ui,
			sessionManager: { getSessionId: () => "coordinator-session" },
		};
		const integrated = await integrateMutatingTicketResult(ctx, gitIdentity, selectedWorkflow, selectedTicket);
		assert.equal(integrated.action, "integrated");
		assert.deepEqual(integrated.integrated_commits, [ticketCommit]);
		assert.equal(integrated.worktree_removed, true);
		assert.equal(await git(repository, "rev-parse", "HEAD"), ticketCommit);
		assert.equal(await git(repository, "show-ref", "--verify", "--quiet", `refs/heads/${ticketBranchName(WORKFLOW_ID, TICKET_ID, TICKET_SLUG)}`).then(() => true, () => false), false);
		await assert.rejects(readFile(resolve(worktree, "feature.txt")), { code: "ENOENT" });
		assert.equal(view.confirms.length, 3);
		for (const confirmation of view.confirms) {
			assert.equal(confirmation.message.startsWith("Complete reviewed Git plan:\n{"), true);
		}
		assert.match(view.confirms[0].message, /git_ticket_reconciliation/u);
		assert.match(view.confirms[1].message, /git_ticket_integration/u);
		assert.match(view.confirms[2].message, /git_ticket_worktree_removal/u);
		assert.ok(directory);
	});
});

test("result helpers enforce executor ownership, coordinator separation, and an explicit return command", async () => {
	const claim = { executor: "manual", session_id: "executor-session", claim_id: "claim-1", claimed_at: NOW };
	const ticketMetadata = metadata({
		status: "in-progress",
		execution: { mode: "delegatable", parallel_safe: true, conflicts_with: [], claim },
	});
	const ticket = inspectedTicket({ status: "in-progress", execution: ticketMetadata.execution, metadata: ticketMetadata });
	const ctx: any = { sessionManager: { getSessionId: () => "executor-session" } };
	const normalized = createCurrentSessionExecutorResult(ctx, ticket, {
		outcome: "done",
		summary: "Done.",
		deliverables: "Delivered.",
		acceptance_criteria_evidence: "Criteria pass.",
		validation: "Tests pass.",
		deviations: "None.",
		follow_ups: "None.",
	});
	assert.equal(normalized.claim.session_id, "executor-session");
	const response = submittedResultResponse({ outcome: "done" }, WORKFLOW_ID, TICKET_ID);
	assert.equal(response.return_to_coordination.command, `/dbz-workflows continue ${WORKFLOW_ID}`);
	const submittedTicket = { ...ticket, execution: { ...ticket.execution, result: { claim, outcome: "done" } } };
	await assert.rejects(prepareCoordinatorAcceptance(ctx, submittedTicket), /cannot accept or complete its own canonical ticket/u);
});

test("formatReviewedGitPlan includes the complete reviewed object and digest", () => {
	const plan = { operation: "git_ticket_worktree", changes: [{ action: "create" }], plan_digest: "f".repeat(64) };
	assert.equal(formatReviewedGitPlan(plan), `Complete reviewed Git plan:\n${JSON.stringify(plan, null, 2)}`);
});
