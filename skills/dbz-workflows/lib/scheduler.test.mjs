import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtemp,
	rm,
	writeFile,
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
	claimTicket,
	recoverTicketClaim,
} from "./claims.mjs";
import {
	ClaimError,
	ExecutorResultError,
	ResultAcceptanceError,
	SchedulerError,
} from "./errors.mjs";
import {
	createExecutorResult,
} from "./executors/protocol.mjs";
import {
	createManualExecutorResult,
	startManualExecution,
} from "./executors/manual.mjs";
import { readFileWithDigest } from "./filesystem.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { readLevelTwoSection } from "./markdown.mjs";
import {
	acceptExecutorResult,
	applyExecutorResult,
} from "./results.mjs";
import {
	calculateSchedulerWave,
	DEFAULT_MAX_CONCURRENCY,
	planSchedulerWave,
} from "./scheduler.mjs";
import { defaultTicketExecution, requiredTicketSections } from "./schemas/ticket.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import { inspectSpec } from "./specs.mjs";
import {
	createTicket,
	inspectTicket,
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
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-scheduler-test-"));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "isolated-home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "scheduler-test@example.invalid");
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
			title: "Schedule isolated ticket execution",
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
			initialIdea: "Coordinate claims, executor results, and bounded waves.",
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
			const inspectedSpec = await inspectSpec(identity, "WF-0001", { homeDirectory });
			const baselinePlan = await createBaselineApprovalPlan(identity, "WF-0001", {
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: inspectedSpec.digest,
				homeDirectory,
				clock: CLOCK_2,
			});
			await applyBaselineApprovalPlan(baselinePlan, {
				identity,
				homeDirectory,
				authorization: authorization(baselinePlan),
			});
		}
		await run({ directory, repository, homeDirectory, identity, workflowId: "WF-0001" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function sections(type) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? "" : `${heading} is bounded and independently verifiable.`,
	]));
}

async function allocate(context, input) {
	const workflow = await inspectWorkflow(context.identity, context.workflowId, {
		homeDirectory: context.homeDirectory,
	});
	return createTicket(context.identity, context.workflowId, input, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_2,
		contextWindowTokens: 128_000,
	});
}

async function enterExecution(context) {
	let workflow = await inspectWorkflow(context.identity, context.workflowId, {
		homeDirectory: context.homeDirectory,
	});
	workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "ready", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
	return (await transitionWorkflowPhase(context.identity, context.workflowId, "execution", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
}

function metadataTicket(id, type = "research", overrides = {}) {
	const delivery = ["research", "implementation", "documentation", "review", "verification"].includes(type);
	return {
		artifact: "ticket",
		schema_version: 1,
		id,
		workflow_id: "WF-0001",
		title: `${type} ${id}`,
		slug: `${type}-${id.toLocaleLowerCase("en-US")}`,
		type,
		status: "open",
		spec_baseline: delivery ? "B-0001" : null,
		research_class: type === "research" ? "delivery" : null,
		depends_on: [],
		superseded_by: [],
		execution: defaultTicketExecution(type),
		context: { spec_sections: [], decisions: [], tickets: [], files: [] },
		context_budget_exception: null,
		created_at: TIMESTAMP_1,
		updated_at: TIMESTAMP_1,
		...overrides,
	};
}

function readiness(ticketIds) {
	return {
		actionable_ticket_ids: [...ticketIds],
		tickets: ticketIds.map((id) => ({ id, actionable: true, reasons: [] })),
	};
}

function doneResult(overrides = {}) {
	return {
		outcome: "done",
		summary: "The bounded objective was completed.",
		deliverables: "All declared deliverables were produced.",
		acceptanceCriteriaEvidence: "Each acceptance criterion has concrete evidence.",
		validation: "The declared validation completed successfully.",
		deviations: "None.",
		followUps: "None.",
		...overrides,
	};
}

function acceptance(integratedCommits = []) {
	return {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: integratedCommits,
	};
}

test("scheduler creates deterministic conflict-free waves with default concurrency four", () => {
	const tickets = Array.from({ length: 6 }, (_unused, index) => metadataTicket(`T-${String(index + 1).padStart(4, "0")}`));
	tickets[1].execution = { ...tickets[1].execution, conflicts_with: [tickets[2].id] };
	tickets[2].execution = { ...tickets[2].execution, conflicts_with: [tickets[1].id] };
	const wave = calculateSchedulerWave(tickets, { readiness: readiness(tickets.map(({ id }) => id)) });
	assert.equal(wave.max_concurrency, DEFAULT_MAX_CONCURRENCY);
	assert.deepEqual(wave.ticket_ids, ["T-0001", "T-0002", "T-0004", "T-0005"]);
	assert.equal(wave.parallel, true);
	assert.equal(wave.claims_created, false);
	assert.deepEqual(wave.deferred_actionable_ticket_ids, ["T-0003", "T-0006"]);

	const dependent = metadataTicket("T-0007", "implementation", {
		depends_on: ["T-0001"],
		execution: { ...defaultTicketExecution("implementation"), parallel_safe: true },
	});
	assert.throws(
		() => calculateSchedulerWave([...tickets, dependent], {
			readiness: readiness([...tickets, dependent].map(({ id }) => id)),
			requestedTicketIds: ["T-0001", "T-0007"],
		}),
		SchedulerError,
	);
});

test("scheduler keeps question, synthesis, and verification tickets exclusive and requires mutating opt-in", () => {
	const synthesis = metadataTicket("T-0001", "synthesis", {
		spec_baseline: null,
	});
	const discoveryResearch = metadataTicket("T-0002", "research", {
		spec_baseline: null,
		research_class: "baseline-blocking",
	});
	let wave = calculateSchedulerWave([synthesis, discoveryResearch], {
		readiness: readiness([synthesis.id, discoveryResearch.id]),
	});
	assert.deepEqual(wave.ticket_ids, [synthesis.id]);
	assert.equal(wave.exclusive, true);
	assert.throws(
		() => calculateSchedulerWave([synthesis, discoveryResearch], {
			readiness: readiness([synthesis.id, discoveryResearch.id]),
			requestedTicketIds: [synthesis.id, discoveryResearch.id],
		}),
		SchedulerError,
	);
	const question = metadataTicket("T-0001", "question-session", { spec_baseline: null });
	wave = calculateSchedulerWave([question, discoveryResearch], {
		readiness: readiness([question.id, discoveryResearch.id]),
	});
	assert.deepEqual(wave.ticket_ids, [question.id]);
	assert.equal(wave.exclusive, true);

	const implementation = metadataTicket("T-0003", "implementation");
	const deliveryResearch = metadataTicket("T-0004");
	assert.throws(
		() => calculateSchedulerWave([implementation, deliveryResearch], {
			readiness: readiness([implementation.id, deliveryResearch.id]),
			requestedTicketIds: [implementation.id, deliveryResearch.id],
		}),
		(error) => error instanceof SchedulerError && /Mutating ticket/u.test(error.message),
	);
	implementation.execution = { ...implementation.execution, parallel_safe: true };
	wave = calculateSchedulerWave([implementation, deliveryResearch], {
		readiness: readiness([implementation.id, deliveryResearch.id]),
		requestedTicketIds: [implementation.id, deliveryResearch.id],
	});
	assert.deepEqual(wave.ticket_ids, [implementation.id, deliveryResearch.id]);

	const verification = metadataTicket("T-0001", "verification");
	const laterResearch = metadataTicket("T-0002");
	wave = calculateSchedulerWave([verification, laterResearch], {
		readiness: readiness([verification.id, laterResearch.id]),
	});
	assert.deepEqual(wave.ticket_ids, [verification.id]);
	assert.equal(wave.exclusive, true);
});

test("durable claims serialize, never expire, and require explicit user-confirmed recovery", async () => {
	await withWorkflow({}, async (context) => {
		const allocated = await allocate(context, {
			title: "Research durable claim behavior",
			type: "research",
			status: "open",
			sections: sections("research"),
		});
		const attempts = await Promise.allSettled([
			claimTicket(context.identity, context.workflowId, allocated.ticket.id, {
				expectedTicketDigest: allocated.ticket.digest,
				executor: "manual",
				sessionId: "manual-session-a",
				homeDirectory: context.homeDirectory,
				clock: CLOCK_2,
				claimIdFactory: () => "claim-a",
			}),
			claimTicket(context.identity, context.workflowId, allocated.ticket.id, {
				expectedTicketDigest: allocated.ticket.digest,
				executor: "manual",
				sessionId: "manual-session-b",
				homeDirectory: context.homeDirectory,
				clock: CLOCK_2,
				claimIdFactory: () => "claim-b",
			}),
		]);
		assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
		assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
		const winner = attempts.find(({ status }) => status === "fulfilled").value;
		let claimed = await inspectTicket(context.identity, context.workflowId, allocated.ticket.id, {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(claimed.status, "in-progress");
		assert.equal(claimed.execution.claim.claim_id, winner.claim.claim_id);

		await assert.rejects(
			claimTicket(context.identity, context.workflowId, claimed.id, {
				expectedTicketDigest: claimed.digest,
				executor: "manual",
				sessionId: "manual-session-later",
				homeDirectory: context.homeDirectory,
				clock: () => new Date("2036-08-03T16:00:00.000Z"),
			}),
			(error) => error instanceof ClaimError && /never expire automatically/u.test(error.message),
		);
		await assert.rejects(
			recoverTicketClaim(context.identity, context.workflowId, claimed.id, {
				expectedTicketDigest: claimed.digest,
				rationale: "The original manual session is unavailable.",
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof ClaimError && error.code === "claim_recovery_required",
		);
		const recovered = await recoverTicketClaim(context.identity, context.workflowId, claimed.id, {
			expectedTicketDigest: claimed.digest,
			rationale: "The original manual session is unavailable.",
			authorization: {
				confirmed: true,
				recovered_by: "user",
				claim_id: winner.claim.claim_id,
			},
			homeDirectory: context.homeDirectory,
			clock: CLOCK_3,
		});
		claimed = recovered.ticket;
		assert.equal(claimed.status, "open");
		assert.equal(claimed.execution.claim, null);
		assert.equal(claimed.execution.claim_recoveries[0].rationale, "The original manual session is unavailable.");

		const staleResult = createExecutorResult({
			workflowId: context.workflowId,
			ticketId: claimed.id,
			claim: winner.claim,
			...doneResult(),
		});
		await assert.rejects(
			applyExecutorResult(context.identity, context.workflowId, claimed.id, staleResult, {
				expectedTicketDigest: claimed.digest,
				homeDirectory: context.homeDirectory,
			}),
			ExecutorResultError,
		);
	});
});

test("manual executors return normalized results but only coordinator acceptance completes tickets", async () => {
	await withWorkflow({}, async (context) => {
		const allocated = await allocate(context, {
			title: "Design coordinator result acceptance",
			type: "design",
			status: "open",
			sections: sections("design"),
		});
		const execution = await startManualExecution(context.identity, context.workflowId, allocated.ticket.id, {
			expectedTicketDigest: allocated.ticket.digest,
			sessionId: "manual-design-session",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
			claimIdFactory: () => "manual-design-claim",
		});
		assert.throws(
			() => createManualExecutorResult(execution, { ...doneResult(), outcome: "completed" }),
			ExecutorResultError,
		);
		const result = createManualExecutorResult(execution, doneResult());
		assert.equal(result.outcome, "done");
		assert.equal((await inspectTicket(context.identity, context.workflowId, allocated.ticket.id, {
			homeDirectory: context.homeDirectory,
		})).status, "in-progress");

		const applied = await applyExecutorResult(context.identity, context.workflowId, allocated.ticket.id, result, {
			expectedTicketDigest: execution.ticket_digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		assert.equal(applied.ticket.status, "in-progress");
		assert.equal(applied.completion_allowed, false);
		await assert.rejects(
			acceptExecutorResult(context.identity, context.workflowId, allocated.ticket.id, {
				...acceptance(),
				validation_verified: false,
			}, {
				expectedTicketDigest: applied.ticket.digest,
				homeDirectory: context.homeDirectory,
			}),
			ResultAcceptanceError,
		);
		const accepted = await acceptExecutorResult(
			context.identity,
			context.workflowId,
			allocated.ticket.id,
			acceptance(),
			{
				expectedTicketDigest: applied.ticket.digest,
				homeDirectory: context.homeDirectory,
				clock: CLOCK_3,
			},
		);
		assert.equal(accepted.ticket.status, "completed");
		assert.equal(accepted.ticket.execution.claim, null);
		assert.equal(accepted.ticket.execution.acceptance.accepted_by, "coordinator");

		const question = await allocate(context, {
			title: "Confirm stakeholder decision",
			type: "question-session",
			status: "open",
			sections: sections("question-session"),
		});
		const questionExecution = await startManualExecution(
			context.identity,
			context.workflowId,
			question.ticket.id,
			{
				expectedTicketDigest: question.ticket.digest,
				sessionId: "manual-question-session",
				homeDirectory: context.homeDirectory,
				claimIdFactory: () => "manual-question-claim",
			},
		);
		const questionResult = createManualExecutorResult(questionExecution, doneResult());
		const appliedQuestion = await applyExecutorResult(
			context.identity,
			context.workflowId,
			question.ticket.id,
			questionResult,
			{
				expectedTicketDigest: questionExecution.ticket_digest,
				homeDirectory: context.homeDirectory,
			},
		);
		await assert.rejects(
			acceptExecutorResult(context.identity, context.workflowId, question.ticket.id, acceptance(), {
				expectedTicketDigest: appliedQuestion.ticket.digest,
				homeDirectory: context.homeDirectory,
			}),
			ResultAcceptanceError,
		);
		const acceptedQuestion = await acceptExecutorResult(
			context.identity,
			context.workflowId,
			question.ticket.id,
			acceptance(),
			{
				expectedTicketDigest: appliedQuestion.ticket.digest,
				humanApproval: { confirmed: true, approved_by: "user" },
				homeDirectory: context.homeDirectory,
			},
		);
		assert.equal(acceptedQuestion.ticket.execution.acceptance.human_approval.approved_by, "user");
	});
});

test("blocked and failed executor outcomes release claims without completing canonical tickets", async () => {
	await withWorkflow({}, async (context) => {
		const blockedTicket = await allocate(context, {
			title: "Design with an external blocker",
			type: "design",
			status: "open",
			sections: sections("design"),
		});
		const blockedExecution = await startManualExecution(
			context.identity,
			context.workflowId,
			blockedTicket.ticket.id,
			{
				expectedTicketDigest: blockedTicket.ticket.digest,
				sessionId: "manual-blocked-session",
				homeDirectory: context.homeDirectory,
				claimIdFactory: () => "manual-blocked-claim",
			},
		);
		const blockedResult = createManualExecutorResult(blockedExecution, doneResult({
			outcome: "blocked",
			reason: "A required stakeholder decision is unavailable.",
		}));
		const blocked = await applyExecutorResult(
			context.identity,
			context.workflowId,
			blockedTicket.ticket.id,
			blockedResult,
			{
				expectedTicketDigest: blockedExecution.ticket_digest,
				homeDirectory: context.homeDirectory,
			},
		);
		assert.equal(blocked.ticket.status, "blocked");
		assert.equal(blocked.ticket.execution.claim, null);
		assert.equal(blocked.claim_released, true);

		const failedTicket = await allocate(context, {
			title: "Design with a failed attempt",
			type: "design",
			status: "open",
			sections: sections("design"),
		});
		const failedExecution = await startManualExecution(
			context.identity,
			context.workflowId,
			failedTicket.ticket.id,
			{
				expectedTicketDigest: failedTicket.ticket.digest,
				sessionId: "manual-failed-session",
				homeDirectory: context.homeDirectory,
				claimIdFactory: () => "manual-failed-claim",
			},
		);
		const failedResult = createManualExecutorResult(failedExecution, doneResult({
			outcome: "failed",
			reason: "The validation command failed deterministically.",
		}));
		const failed = await applyExecutorResult(
			context.identity,
			context.workflowId,
			failedTicket.ticket.id,
			failedResult,
			{
				expectedTicketDigest: failedExecution.ticket_digest,
				homeDirectory: context.homeDirectory,
			},
		);
		assert.equal(failed.ticket.status, "open");
		assert.equal(failed.ticket.execution.claim, null);
		assert.equal(failed.ticket.execution.result.outcome, "failed");
	});
});

test("mutating ticket acceptance requires exact final commits integrated into the workflow branch", async () => {
	await withWorkflow({ baselined: true }, async (context) => {
		const allocated = await allocate(context, {
			title: "Implement integrated result evidence",
			type: "implementation",
			status: "open",
			sections: sections("implementation"),
		});
		await enterExecution(context);
		const planned = await planSchedulerWave(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			contextWindowTokens: 128_000,
		});
		assert.deepEqual(planned.ticket_ids, [allocated.ticket.id]);
		assert.equal(planned.claims_created, false);

		const execution = await startManualExecution(context.identity, context.workflowId, allocated.ticket.id, {
			expectedTicketDigest: allocated.ticket.digest,
			sessionId: "manual-implementation-session",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
			claimIdFactory: () => "manual-implementation-claim",
			contextWindowTokens: 128_000,
		});
		await writeFile(resolve(context.repository, "implemented.txt"), "implemented\n", "utf8");
		await git(context.repository, "add", "implemented.txt");
		await git(
			context.repository,
			"commit",
			"--quiet",
			"-m",
			"feat: add integrated evidence",
			"-m",
			`DBZ-Workflow: ${context.workflowId}\nDBZ-Ticket: ${allocated.ticket.id}`,
		);
		const integratedCommit = await git(context.repository, "rev-parse", "HEAD");
		const result = createManualExecutorResult(execution, doneResult({
			workerCommits: [integratedCommit],
		}));
		const applied = await applyExecutorResult(context.identity, context.workflowId, allocated.ticket.id, result, {
			expectedTicketDigest: execution.ticket_digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		await assert.rejects(
			acceptExecutorResult(context.identity, context.workflowId, allocated.ticket.id, acceptance(), {
				expectedTicketDigest: applied.ticket.digest,
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof ExecutorResultError || error instanceof ResultAcceptanceError,
		);
		const accepted = await acceptExecutorResult(
			context.identity,
			context.workflowId,
			allocated.ticket.id,
			acceptance([integratedCommit]),
			{
				expectedTicketDigest: applied.ticket.digest,
				homeDirectory: context.homeDirectory,
				clock: CLOCK_3,
			},
		);
		assert.equal(accepted.ticket.status, "completed");
		assert.deepEqual(accepted.ticket.execution.result.integrated_commits, [integratedCommit]);
		const source = (await readFileWithDigest(accepted.ticket.path, { encoding: "utf8" })).data;
		assert.match(readLevelTwoSection(source, "Result"), /### Integrated Commits/u);
		assert.match(readLevelTwoSection(source, "Result"), new RegExp(integratedCommit, "u"));
	});
});
