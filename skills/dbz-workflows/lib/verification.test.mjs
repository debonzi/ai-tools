import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyBaselineApprovalPlan, createBaselineApprovalPlan } from "./baselines.mjs";
import { createManualExecutorResult, startManualExecution } from "./executors/manual.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { acceptExecutorResult, applyExecutorResult } from "./results.mjs";
import { requiredTicketSections } from "./schemas/ticket.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import { inspectSpec, updateSpecDraftSections } from "./specs.mjs";
import { createTicket, inspectTicket } from "./tickets.mjs";
import {
	applyWorkflowFinalIntegrationPlan,
	completeWorkflowAfterIntegration,
	createWorkflowFinalIntegrationPlan,
	deriveVerificationStaleness,
	inspectVerification,
	recordVerificationOutcome,
	startVerification,
} from "./verification.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	inspectWorkflow,
	transitionWorkflowPhase,
} from "./workflows.mjs";

const execFileAsync = promisify(execFile);
const CLOCK_1 = () => new Date("2026-08-03T15:30:00.000Z");
const CLOCK_2 = () => new Date("2026-08-03T16:00:00.000Z");
const CLOCK_3 = () => new Date("2026-08-03T17:00:00.000Z");
const CLOCK_4 = () => new Date("2026-08-03T18:00:00.000Z");

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

function sections(type) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? "" : `${heading} has deterministic evidence.`,
	]));
}

function doneResult(workerCommits = []) {
	return {
		outcome: "done",
		summary: "The ticket objective was completed.",
		deliverables: "All declared deliverables were produced.",
		acceptanceCriteriaEvidence: "Every ticket criterion has concrete evidence.",
		validation: "The ticket validation passed.",
		deviations: "None.",
		followUps: "None.",
		workerCommits,
	};
}

async function withBaselinedWorkflow(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-verification-test-"));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "verification-test@example.invalid");
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
		let identity = await inspectGitProject(repository);
		const setupPlan = await createSetupPlan(identity, { mode: "managed", homeDirectory, clock: CLOCK_1 });
		await applySetupPlan(setupPlan, { identity, homeDirectory, authorization: authorization(setupPlan) });
		const reservationPlan = await createWorkflowReservationPlan(identity, {
			title: "Verify and integrate delivery",
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
			initialIdea: "Deliver behavior with exact criterion and integration evidence.",
			homeDirectory,
			clock: CLOCK_1,
		});
		await applyWorkflowStartPlan(startPlan, {
			identity,
			homeDirectory,
			authorization: authorization(startPlan),
		});
		identity = await inspectGitProject(repository);
		let workflow = await inspectWorkflow(identity, "WF-0001", { homeDirectory });
		let spec = await inspectSpec(identity, "WF-0001", { homeDirectory });
		await updateSpecDraftSections(identity, "WF-0001", [{
			heading: "Acceptance Criteria",
			content: "- The delivered workflow passes its focused validation.\n- The selected target contains the verified changes.",
			operation: "append",
		}], {
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			homeDirectory,
			clock: CLOCK_1,
		});
		workflow = await inspectWorkflow(identity, "WF-0001", { homeDirectory });
		spec = await inspectSpec(identity, "WF-0001", { homeDirectory });
		const baselinePlan = await createBaselineApprovalPlan(identity, "WF-0001", {
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			homeDirectory,
			clock: CLOCK_2,
		});
		await applyBaselineApprovalPlan(baselinePlan, {
			identity,
			homeDirectory,
			authorization: authorization(baselinePlan),
		});
		await run({ directory, repository, homeDirectory, identity, workflowId: "WF-0001" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function allocate(context, input) {
	const workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	return createTicket(context.identity, context.workflowId, input, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_2,
		contextWindowTokens: 128_000,
	});
}

async function enterExecution(context) {
	let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "ready", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
	return (await transitionWorkflowPhase(context.identity, context.workflowId, "execution", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
}

async function completeReadOnlyTicket(context, ticketId, sessionId) {
	const ticket = await inspectTicket(context.identity, context.workflowId, ticketId, { homeDirectory: context.homeDirectory });
	const execution = await startManualExecution(context.identity, context.workflowId, ticketId, {
		expectedTicketDigest: ticket.digest,
		sessionId,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_2,
		claimIdFactory: () => `${sessionId}-claim`,
		contextWindowTokens: 128_000,
	});
	const applied = await applyExecutorResult(
		context.identity,
		context.workflowId,
		ticketId,
		createManualExecutorResult(execution, doneResult()),
		{ expectedTicketDigest: execution.ticket_digest, homeDirectory: context.homeDirectory, clock: CLOCK_3 },
	);
	return acceptExecutorResult(context.identity, context.workflowId, ticketId, {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: [],
	}, { expectedTicketDigest: applied.ticket.digest, homeDirectory: context.homeDirectory, clock: CLOCK_3 });
}

async function completeMutatingTicket(context, ticketId) {
	const ticket = await inspectTicket(context.identity, context.workflowId, ticketId, { homeDirectory: context.homeDirectory });
	const execution = await startManualExecution(context.identity, context.workflowId, ticketId, {
		expectedTicketDigest: ticket.digest,
		sessionId: `mutating-${ticketId}`,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_2,
		claimIdFactory: () => `mutating-${ticketId}-claim`,
		contextWindowTokens: 128_000,
	});
	await writeFile(resolve(context.repository, `${ticketId}.txt`), "delivered\n", "utf8");
	await git(context.repository, "add", `${ticketId}.txt`);
	await git(
		context.repository,
		"commit",
		"--quiet",
		"-m",
		`feat: deliver ${ticketId}`,
		"-m",
		`DBZ-Workflow: ${context.workflowId}\nDBZ-Ticket: ${ticketId}`,
	);
	const commit = await git(context.repository, "rev-parse", "HEAD");
	const applied = await applyExecutorResult(
		context.identity,
		context.workflowId,
		ticketId,
		createManualExecutorResult(execution, doneResult([commit])),
		{ expectedTicketDigest: execution.ticket_digest, homeDirectory: context.homeDirectory, clock: CLOCK_3 },
	);
	await acceptExecutorResult(context.identity, context.workflowId, ticketId, {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: [commit],
	}, { expectedTicketDigest: applied.ticket.digest, homeDirectory: context.homeDirectory, clock: CLOCK_3 });
	return commit;
}

test("baseline changes and suspended baselines derive stale verification without persisting stale state", () => {
	const metadata = {
		artifact: "verification",
		schema_version: 1,
		workflow_id: "WF-0001",
		baseline: "B-0001",
		verified_commit: null,
		outcome: "passed",
		verified_at: "2026-08-03T17:00:00.000Z",
		attempt: 1,
		criteria_sha256: "a".repeat(64),
		project_changes: false,
		blocking_deviations: 0,
		correction_tickets: [],
		integration: {
			required: false,
			status: "not-required",
			target_branch: null,
			target_commit: null,
			integrated_at: null,
			validated_at: null,
			validation: null,
		},
		created_at: "2026-08-03T16:00:00.000Z",
		updated_at: "2026-08-03T17:00:00.000Z",
	};
	const staleness = deriveVerificationStaleness(metadata, {
		workflow: { current_baseline: "B-0002", git: { base_commit: "b".repeat(40) } },
		spec: { current_baseline: "B-0002", status: "suspended" },
		workflowCommit: "b".repeat(40),
	});
	assert.equal(staleness.stale, true);
	assert.deepEqual(staleness.reasons.map(({ code }) => code), ["baseline_mismatch", "baseline_not_active"]);
});

function criterionEvidence(outcome = "passed") {
	return [
		{ id: "AC-001", outcome, evidence: "Focused validation demonstrates the required behavior." },
		{ id: "AC-002", outcome, evidence: "Git containment demonstrates delivery to the selected target." },
	];
}

test("no-change verification records every criterion and completes without final integration", async () => {
	await withBaselinedWorkflow(async (context) => {
		const review = await allocate(context, {
			title: "Review the no-code delivery",
			type: "review",
			status: "open",
			sections: sections("review"),
		});
		const verifier = await allocate(context, {
			title: "Verify baseline compliance",
			type: "verification",
			status: "open",
			depends_on: [review.ticket.id],
			sections: sections("verification"),
		});
		await enterExecution(context);
		await completeReadOnlyTicket(context, review.ticket.id, "review-session");
		let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const started = await startVerification(context.identity, context.workflowId, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_3,
		});
		assert.equal(started.verification.outcome, "pending");
		assert.equal(started.verification.verified_commit, null);
		await completeReadOnlyTicket(context, verifier.ticket.id, "verification-session");
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const recorded = await recordVerificationOutcome(context.identity, context.workflowId, {
			outcome: "passed",
			criterionEvidence: criterionEvidence(),
			mandatoryTicketEvidence: [
				{ ticket_id: review.ticket.id, evidence: "Review result is accepted." },
				{ ticket_id: verifier.ticket.id, evidence: "Verification result is accepted." },
			],
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_4,
		});
		assert.equal(recorded.workflow.phase, "completed");
		assert.equal(recorded.verification.metadata.integration.status, "not-required");
	});
});

test("failed verification returns to execution only through explicit correction and next-pass tickets", async () => {
	await withBaselinedWorkflow(async (context) => {
		const verifier = await allocate(context, {
			title: "Run the first verification pass",
			type: "verification",
			status: "open",
			sections: sections("verification"),
		});
		await enterExecution(context);
		let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await startVerification(context.identity, context.workflowId, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		});
		await completeReadOnlyTicket(context, verifier.ticket.id, "first-verifier");
		const correction = await allocate(context, {
			title: "Correct the failed behavior",
			type: "implementation",
			status: "open",
			sections: sections("implementation"),
		});
		const nextVerifier = await allocate(context, {
			title: "Run the corrected verification pass",
			type: "verification",
			status: "open",
			depends_on: [correction.ticket.id],
			sections: sections("verification"),
		});
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const failed = await recordVerificationOutcome(context.identity, context.workflowId, {
			outcome: "failed",
			criterionEvidence: criterionEvidence("failed"),
			mandatoryTicketEvidence: [{ ticket_id: verifier.ticket.id, evidence: "The first verifier result is accepted." }],
			correctionTicketIds: [correction.ticket.id, nextVerifier.ticket.id],
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
		});
		assert.equal(failed.workflow.phase, "execution");
		assert.deepEqual(failed.correction_ticket_ids, [correction.ticket.id, nextVerifier.ticket.id]);
	});
});

test("changed workflow commits invalidate verification and exact confirmed integration gates completion", async () => {
	await withBaselinedWorkflow(async (context) => {
		const implementation = await allocate(context, {
			title: "Implement the verified change",
			type: "implementation",
			status: "open",
			sections: sections("implementation"),
		});
		const verifier = await allocate(context, {
			title: "Verify the integrated implementation",
			type: "verification",
			status: "open",
			depends_on: [implementation.ticket.id],
			sections: sections("verification"),
		});
		await enterExecution(context);
		const delivered = await completeMutatingTicket(context, implementation.ticket.id);
		let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await startVerification(context.identity, context.workflowId, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		});
		await completeReadOnlyTicket(context, verifier.ticket.id, "project-verifier");
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		let verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await recordVerificationOutcome(context.identity, context.workflowId, {
			outcome: "passed",
			criterionEvidence: criterionEvidence(),
			mandatoryTicketEvidence: [
				{ ticket_id: implementation.ticket.id, evidence: `Integrated commit ${delivered} is accepted.` },
				{ ticket_id: verifier.ticket.id, evidence: "Final verification result is accepted." },
			],
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
		});
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		assert.equal(verification.stale, false);
		assert.equal(workflow.conditions.includes("awaiting-integration"), true);
		const plan = await createWorkflowFinalIntegrationPlan(context.identity, context.workflowId, {
			targetBranch: "main",
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
		});
		assert.equal(plan.git_plan.action, "fast_forward_target_ref");
		const integrated = await applyWorkflowFinalIntegrationPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
			clock: CLOCK_4,
		});
		assert.equal(integrated.git.contained, true);
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const completed = await completeWorkflowAfterIntegration(context.identity, context.workflowId, {
			passed: true,
			commands: ["npm test"],
			evidence: "The complete suite passed after final integration.",
			validated_commit: integrated.git.target_commit,
		}, {
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_4,
		});
		assert.equal(completed.workflow.phase, "completed");
		assert.equal(completed.workflow.metadata.git.integrated_commit, delivered);
		assert.equal(await git(context.repository, "rev-parse", "main"), delivered);
	});

	await withBaselinedWorkflow(async (context) => {
		const implementation = await allocate(context, {
			title: "Implement a change before stale verification",
			type: "implementation",
			status: "open",
			sections: sections("implementation"),
		});
		const verifier = await allocate(context, {
			title: "Verify before another commit arrives",
			type: "verification",
			status: "open",
			depends_on: [implementation.ticket.id],
			sections: sections("verification"),
		});
		await enterExecution(context);
		await completeMutatingTicket(context, implementation.ticket.id);
		let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await startVerification(context.identity, context.workflowId, { expectedWorkflowDigest: workflow.digest, homeDirectory: context.homeDirectory });
		await completeReadOnlyTicket(context, verifier.ticket.id, "stale-verifier");
		workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		let verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await recordVerificationOutcome(context.identity, context.workflowId, {
			outcome: "passed",
			criterionEvidence: criterionEvidence(),
			mandatoryTicketEvidence: [
				{ ticket_id: implementation.ticket.id, evidence: "Implementation result is accepted." },
				{ ticket_id: verifier.ticket.id, evidence: "Verification result is accepted." },
			],
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory: context.homeDirectory,
		});
		await writeFile(resolve(context.repository, "late.txt"), "late\n", "utf8");
		await git(context.repository, "add", "late.txt");
		await git(context.repository, "commit", "--quiet", "-m", "late workflow commit");
		verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		assert.equal(verification.stale, true);
		assert.ok(verification.staleness.reasons.some(({ code }) => code === "workflow_commit_changed"));
	});
});
