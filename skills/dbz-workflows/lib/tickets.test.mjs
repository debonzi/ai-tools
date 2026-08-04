import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtemp,
	rm,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	applyBaselineApprovalPlan,
	createBaselineApprovalPlan,
} from "./baselines.mjs";
import {
	BaselineError,
	RevisionConflictError,
	TicketError,
} from "./errors.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import { inspectSpec } from "./specs.mjs";
import { requiredTicketSections } from "./schemas/ticket.mjs";
import {
	createTicket,
	inspectTicket,
	listTickets,
	queryTicketReadiness,
	transitionTicketStatus,
} from "./tickets.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	inspectWorkflow,
	transitionWorkflowPhase,
} from "./workflows.mjs";

const execFileAsync = promisify(execFile);
const TIMESTAMP_1 = "2026-08-03T15:30:00.000Z";
const TIMESTAMP_2 = "2026-08-03T16:00:00.000Z";
const TIMESTAMP_3 = "2026-08-03T17:00:00.000Z";
const CLOCK_1 = () => new Date(TIMESTAMP_1);
const CLOCK_2 = () => new Date(TIMESTAMP_2);
const CLOCK_3 = () => new Date(TIMESTAMP_3);

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function withWorkflow({ baselined = false } = {}, run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-ticket-test-"));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "isolated-home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "ticket-test@example.invalid");
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
		let identity = await inspectGitProject(repository);
		const setupPlan = await createSetupPlan(identity, {
			mode: "managed",
			homeDirectory,
			clock: CLOCK_1,
		});
		await applySetupPlan(setupPlan, {
			identity,
			homeDirectory,
			authorization: authorization(setupPlan),
		});
		const reservationPlan = await createWorkflowReservationPlan(identity, {
			title: "Deliver ticket contracts",
			homeDirectory,
			clock: CLOCK_1,
		});
		const reserved = await applyWorkflowReservationPlan(reservationPlan, {
			identity,
			homeDirectory,
			authorization: authorization(reservationPlan),
		});
		identity = await inspectGitProject(repository);
		const startPlan = await createWorkflowStartPlan(identity, {
			reservation: reserved.reservation,
			initialIdea: "Implement deterministic workflow ticket contracts.",
			homeDirectory,
			clock: CLOCK_1,
		});
		await applyWorkflowStartPlan(startPlan, {
			identity,
			homeDirectory,
			authorization: authorization(startPlan),
		});
		identity = await inspectGitProject(repository);
		if (baselined) {
			const workflow = await inspectWorkflow(identity, "WF-0001", { homeDirectory });
			const spec = await inspectSpec(identity, "WF-0001", { homeDirectory });
			const plan = await createBaselineApprovalPlan(identity, "WF-0001", {
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
				homeDirectory,
				clock: CLOCK_2,
			});
			await applyBaselineApprovalPlan(plan, {
				identity,
				homeDirectory,
				authorization: authorization(plan),
			});
		}
		await run({ directory, repository, homeDirectory, identity, workflowId: "WF-0001" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function sections(type, { result = "" } = {}) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? result : `${heading} is bounded and independently verifiable.`,
	]));
}

async function allocate(context, input, options = {}) {
	const workflow = await inspectWorkflow(context.identity, context.workflowId, {
		homeDirectory: context.homeDirectory,
	});
	return createTicket(context.identity, context.workflowId, input, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
		clock: options.clock ?? CLOCK_2,
		contextWindowTokens: options.contextWindowTokens,
	});
}

test("ticket allocation is monotonic, keeps immutable slugs, and blocks implementation behind baseline research", async () => {
	await withWorkflow({}, async (context) => {
		const research = await allocate(context, {
			title: "Research compatibility",
			type: "research",
			status: "open",
			sections: sections("research", { result: "Compatibility evidence was collected." }),
		});
		assert.equal(research.ticket.id, "T-0001");
		assert.equal(research.ticket.research_class, "baseline-blocking");
		assert.equal(research.ticket.spec_baseline, null);

		await assert.rejects(
			allocate(context, {
				title: "Implement before research",
				type: "implementation",
				status: "open",
				sections: sections("implementation"),
			}),
			(error) => error instanceof TicketError && /baseline-blocking research/u.test(error.message),
		);
		const workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const spec = await inspectSpec(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await assert.rejects(
			createBaselineApprovalPlan(context.identity, context.workflowId, {
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof BaselineError && /baseline-blocking research/u.test(error.message),
		);

		let completedResearch = (await transitionTicketStatus(
			context.identity,
			context.workflowId,
			research.ticket.id,
			"in-progress",
			{
				expectedTicketDigest: research.ticket.digest,
				homeDirectory: context.homeDirectory,
			},
		)).ticket;
		completedResearch = (await transitionTicketStatus(
			context.identity,
			context.workflowId,
			completedResearch.id,
			"completed",
			{
				expectedTicketDigest: completedResearch.digest,
				homeDirectory: context.homeDirectory,
			},
		)).ticket;
		await assert.rejects(
			createBaselineApprovalPlan(context.identity, context.workflowId, {
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof BaselineError && /synthesis ticket/u.test(error.message),
		);

		await unlink(completedResearch.path);
		const second = await allocate(context, {
			title: "日本語",
			type: "design",
			status: "draft",
			sections: sections("design"),
		});
		assert.equal(second.ticket.id, "T-0002");
		assert.equal(second.ticket.slug, "ticket");
		assert.match(second.ticket.path, /T-0002-ticket\.md$/u);
		assert.deepEqual((await listTickets(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		})).map(({ id }) => id), ["T-0002"]);
	});
});

test("competing ticket allocations serialize and never reuse the consumed ID", async () => {
	await withWorkflow({}, async (context) => {
		const workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const create = (title) => createTicket(context.identity, context.workflowId, {
			title,
			type: "design",
			status: "open",
			sections: sections("design"),
		}, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		const attempts = await Promise.allSettled([
			create("Competing design alpha"),
			create("Competing design beta"),
		]);
		assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
		assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
		assert.ok(attempts.find(({ status }) => status === "rejected").reason instanceof RevisionConflictError);
		assert.deepEqual((await listTickets(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		})).map(({ id }) => id), ["T-0001"]);

		const retry = await allocate(context, {
			title: "Retried competing design",
			type: "design",
			status: "open",
			sections: sections("design"),
		});
		assert.equal(retry.ticket.id, "T-0002");
	});
});

test("ticket transitions enforce contracts, rationales, recovery paths, and terminal behavior", async () => {
	await withWorkflow({}, async (context) => {
		const emptyDraft = await allocate(context, {
			title: "Incomplete draft",
			type: "design",
		});
		await assert.rejects(
			transitionTicketStatus(context.identity, context.workflowId, emptyDraft.ticket.id, "open", {
				expectedTicketDigest: emptyDraft.ticket.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof TicketError && /empty contract sections/u.test(error.message),
		);
		const cancelledDraft = await transitionTicketStatus(
			context.identity,
			context.workflowId,
			emptyDraft.ticket.id,
			"cancelled",
			{
				expectedTicketDigest: emptyDraft.ticket.digest,
				rationale: "The draft is no longer required.",
				homeDirectory: context.homeDirectory,
			},
		);
		assert.equal(cancelledDraft.ticket.status, "cancelled");

		let current = (await allocate(context, {
			title: "Design state transitions",
			type: "design",
			status: "draft",
			sections: sections("design", { result: "The design contract was completed." }),
		})).ticket;
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "open", {
			expectedTicketDigest: current.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		})).ticket;
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "in-progress", {
			expectedTicketDigest: current.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		})).ticket;
		await assert.rejects(
			transitionTicketStatus(context.identity, context.workflowId, current.id, "blocked", {
				expectedTicketDigest: current.digest,
				homeDirectory: context.homeDirectory,
			}),
			/rationale/u,
		);
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "blocked", {
			expectedTicketDigest: current.digest,
			rationale: "A required architecture decision is pending.",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		})).ticket;
		assert.equal(current.metadata.status_reason.rationale, "A required architecture decision is pending.");
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "open", {
			expectedTicketDigest: current.digest,
			rationale: "The architecture decision is now accepted.",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_3,
		})).ticket;
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "in-progress", {
			expectedTicketDigest: current.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_3,
		})).ticket;
		current = (await transitionTicketStatus(context.identity, context.workflowId, current.id, "completed", {
			expectedTicketDigest: current.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_3,
		})).ticket;
		assert.equal(current.status, "completed");
		await assert.rejects(
			transitionTicketStatus(context.identity, context.workflowId, current.id, "open", {
				expectedTicketDigest: current.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof TicketError && error.code === "invalid_ticket_transition",
		);
	});
});

test("delivery research participates in a baseline-bound DAG and releases dependent implementation only after completion", async () => {
	await withWorkflow({ baselined: true }, async (context) => {
		let research = (await allocate(context, {
			title: "Research delivery detail",
			type: "research",
			researchClass: "delivery",
			status: "open",
			sections: sections("research", { result: "The supported API behavior is confirmed." }),
		})).ticket;
		const implementation = (await allocate(context, {
			title: "Implement researched behavior",
			type: "implementation",
			status: "open",
			dependsOn: [research.id],
			context: {
				specSections: ["Initial Idea"],
				tickets: [research.id],
				files: ["src/implementation.mjs"],
			},
			sections: sections("implementation"),
		})).ticket;
		assert.equal(research.spec_baseline, "B-0001");
		assert.equal(implementation.spec_baseline, "B-0001");
		await assert.rejects(
			transitionTicketStatus(context.identity, context.workflowId, research.id, "in-progress", {
				expectedTicketDigest: research.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof TicketError && /not actionable/u.test(error.message),
		);

		let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "ready", {
			expectedDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		})).workflow;
		workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "execution", {
			expectedDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		})).workflow;
		assert.equal(workflow.phase, "execution");

		let readiness = await queryTicketReadiness(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			contextWindowTokens: 128_000,
		});
		assert.deepEqual(readiness.actionable_ticket_ids, [research.id]);
		assert.equal(readiness.context_budgets[implementation.id].segments.some(({ kind }) => kind === "ticket_result"), true);
		assert.equal(readiness.context_budgets[implementation.id].segments.some(({ kind }) => kind === "spec_section"), true);
		await assert.rejects(
			transitionTicketStatus(context.identity, context.workflowId, implementation.id, "in-progress", {
				expectedTicketDigest: implementation.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof TicketError && /not actionable/u.test(error.message),
		);

		research = (await transitionTicketStatus(context.identity, context.workflowId, research.id, "in-progress", {
			expectedTicketDigest: research.digest,
			homeDirectory: context.homeDirectory,
		})).ticket;
		research = (await transitionTicketStatus(context.identity, context.workflowId, research.id, "completed", {
			expectedTicketDigest: research.digest,
			homeDirectory: context.homeDirectory,
		})).ticket;
		readiness = await queryTicketReadiness(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			contextWindowTokens: 128_000,
		});
		assert.deepEqual(readiness.actionable_ticket_ids, [implementation.id]);
		assert.equal((await inspectTicket(context.identity, context.workflowId, research.id, {
			homeDirectory: context.homeDirectory,
		})).status, "completed");
	});
});
