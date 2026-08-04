import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyBaselineApprovalPlan, createBaselineApprovalPlan } from "./baselines.mjs";
import {
	ConfirmationRequiredError,
	IssueAdapterError,
	PlanMismatchError,
} from "./errors.mjs";
import { createManualExecutorResult, startManualExecution } from "./executors/manual.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import {
	applyIssueClosurePlan,
	applyIssueLinkPlan,
	createIssueClosurePlan,
	createIssueLinkPlan,
	evaluateIssueClosureEligibility,
	inspectLinkedIssue,
} from "./issues-adapter.mjs";
import { acceptExecutorResult, applyExecutorResult } from "./results.mjs";
import { requiredTicketSections } from "./schemas/ticket.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import { inspectSpec, updateSpecDraftSections } from "./specs.mjs";
import { createTicket } from "./tickets.mjs";
import { inspectVerification, recordVerificationOutcome, startVerification } from "./verification.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	cancelWorkflow,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	inspectWorkflow,
	transitionWorkflowPhase,
} from "./workflows.mjs";

const execFileAsync = promisify(execFile);
const CLOCK_1 = () => new Date("2026-08-03T15:30:00.000Z");
const CLOCK_2 = () => new Date("2026-08-03T16:00:00.000Z");
const CLOCK_3 = () => new Date("2026-08-03T17:00:00.000Z");
const ISSUES_SCRIPT = resolve("skills/dbz-issues/scripts/issues.py");

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function issueCli(repository, ...args) {
	const { stdout } = await execFileAsync("python3", [ISSUES_SCRIPT, ...args], {
		cwd: repository,
		encoding: "utf8",
	});
	return JSON.parse(stdout);
}

function ticketSections(type) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? "" : `${heading} has concrete evidence.`,
	]));
}

async function withWorkflow(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-issues-adapter-test-"));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "issues-adapter-test@example.invalid");
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
		await writeFile(resolve(repository, ".gitignore"), "issues/\n", "utf8");
		await git(repository, "add", ".gitignore");
		await git(repository, "commit", "--quiet", "-m", "chore: ignore isolated test issues");
		await issueCli(repository, "init");
		const created = await issueCli(
			repository,
			"create",
			"--title",
			"Deliver linked workflow",
			"--description",
			"Track workflow delivery without automatic closure.",
		);
		let identity = await inspectGitProject(repository);
		const setup = await createSetupPlan(identity, { mode: "managed", homeDirectory, clock: CLOCK_1 });
		await applySetupPlan(setup, { identity, homeDirectory, authorization: authorization(setup) });
		const reservation = await createWorkflowReservationPlan(identity, {
			title: "Resolve a local issue",
			homeDirectory,
			clock: CLOCK_1,
		});
		const reserved = await applyWorkflowReservationPlan(reservation, {
			identity,
			homeDirectory,
			authorization: authorization(reservation),
		});
		identity = await inspectGitProject(repository);
		const start = await createWorkflowStartPlan(identity, {
			reservation: reserved.reservation,
			initialIdea: "Deliver the issue and preserve explicit closure authority.",
			homeDirectory,
			clock: CLOCK_1,
		});
		await applyWorkflowStartPlan(start, {
			identity,
			homeDirectory,
			authorization: authorization(start),
		});
		identity = await inspectGitProject(repository);
		await run({
			directory,
			repository,
			homeDirectory,
			identity,
			workflowId: "WF-0001",
			issueId: created.issue.id,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function baseline(context) {
	let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	let spec = await inspectSpec(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	await updateSpecDraftSections(context.identity, context.workflowId, [{
		heading: "Acceptance Criteria",
		content: "- The linked issue is delivered with concrete verification evidence.",
		operation: "append",
	}], {
		expectedWorkflowDigest: workflow.digest,
		expectedSpecDigest: spec.digest,
		homeDirectory: context.homeDirectory,
	});
	workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	spec = await inspectSpec(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	const plan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
		expectedWorkflowDigest: workflow.digest,
		expectedSpecDigest: spec.digest,
		homeDirectory: context.homeDirectory,
	});
	await applyBaselineApprovalPlan(plan, {
		identity: context.identity,
		homeDirectory: context.homeDirectory,
		authorization: authorization(plan),
	});
}

async function link(context, relation) {
	const workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	const plan = await createIssueLinkPlan(context.identity, context.workflowId, context.issueId, relation, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	});
	return applyIssueLinkPlan(plan, {
		identity: context.identity,
		homeDirectory: context.homeDirectory,
		authorization: authorization(plan),
	});
}

async function completeNoCodeWorkflow(context, { deviations = [] } = {}) {
	await baseline(context);
	let workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	const verifier = await createTicket(context.identity, context.workflowId, {
		title: "Verify linked issue delivery",
		type: "verification",
		status: "open",
		sections: ticketSections("verification"),
	}, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
		contextWindowTokens: 128_000,
	});
	workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "ready", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
	workflow = (await transitionWorkflowPhase(context.identity, context.workflowId, "execution", {
		expectedDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	})).workflow;
	await startVerification(context.identity, context.workflowId, {
		expectedWorkflowDigest: workflow.digest,
		homeDirectory: context.homeDirectory,
	});
	const execution = await startManualExecution(context.identity, context.workflowId, verifier.ticket.id, {
		expectedTicketDigest: verifier.ticket.digest,
		sessionId: "issue-verifier",
		claimIdFactory: () => "issue-verifier-claim",
		homeDirectory: context.homeDirectory,
		contextWindowTokens: 128_000,
	});
	const result = createManualExecutorResult(execution, {
		outcome: "done",
		summary: "Verification completed.",
		deliverables: "Criterion evidence was produced.",
		acceptanceCriteriaEvidence: "The linked issue criterion passed.",
		validation: "Focused validation passed.",
		deviations: "None.",
		followUps: "None.",
	});
	const applied = await applyExecutorResult(context.identity, context.workflowId, verifier.ticket.id, result, {
		expectedTicketDigest: execution.ticket_digest,
		homeDirectory: context.homeDirectory,
	});
	await acceptExecutorResult(context.identity, context.workflowId, verifier.ticket.id, {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: [],
	}, { expectedTicketDigest: applied.ticket.digest, homeDirectory: context.homeDirectory });
	workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	const verification = await inspectVerification(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
	return recordVerificationOutcome(context.identity, context.workflowId, {
		outcome: "passed",
		criterionEvidence: [{ id: "AC-001", outcome: "passed", evidence: "Focused verification passed." }],
		mandatoryTicketEvidence: [{ ticket_id: verifier.ticket.id, evidence: "The verifier result is accepted." }],
		deviations,
		expectedWorkflowDigest: workflow.digest,
		expectedVerificationDigest: verification.digest,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_3,
	});
}

test("issue linking is bidirectional, idempotent, and leaves the issue open", async () => {
	await withWorkflow(async (context) => {
		const linked = await link(context, "related");
		assert.equal(linked.workflow.issues[0].relation, "related");
		assert.equal(linked.issue.status, "open");
		assert.deepEqual(linked.issue.workflows, [{ id: context.workflowId, relation: "related" }]);
		const workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		const noopPlan = await createIssueLinkPlan(context.identity, context.workflowId, context.issueId, "related", {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		});
		assert.equal(noopPlan.action, "noop");
		const issue = await inspectLinkedIssue(context.identity, context.issueId);
		assert.equal(issue.status, "open");
	});
});

function deviationDetermination(eligibility, effect, rationale) {
	return {
		issue_id: eligibility.issue_id,
		verification_digest: eligibility.deviation_review.verification_digest,
		effects: eligibility.deviation_review.deviations.map((deviation) => ({
			deviation_id: deviation.id,
			effect,
			rationale,
		})),
	};
}

test("only bidirectional resolves links on completed verified workflows become closure-eligible", async () => {
	await withWorkflow(async (context) => {
		await link(context, "resolves");
		await completeNoCodeWorkflow(context);
		let eligibility = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(eligibility.eligible, true);
		assert.equal(eligibility.deviation_review.status, "no_recorded_deviations");
		await issueCli(
			context.repository,
			"unlink-workflow",
			context.issueId,
			"--workflow-id",
			context.workflowId,
			"--relation",
			"resolves",
		);
		eligibility = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(eligibility.eligible, false);
		assert.ok(eligibility.reasons.some(({ code }) => code === "bidirectional_link_missing_or_mismatched"));
		assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
	});
});

test("issue closure requires authorization tied to the exact reviewed plan and remains terminal", async () => {
	await withWorkflow(async (context) => {
		await link(context, "resolves");
		await completeNoCodeWorkflow(context);
		const plan = await createIssueClosurePlan(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		await assert.rejects(
			applyIssueClosurePlan(plan, { identity: context.identity, homeDirectory: context.homeDirectory }),
			ConfirmationRequiredError,
		);
		await assert.rejects(
			applyIssueClosurePlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: { confirmed: true, planDigest: "0".repeat(64) },
			}),
			ConfirmationRequiredError,
		);
		assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
		const closed = await applyIssueClosurePlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		assert.equal(closed.issue.status, "closed");
		await assert.rejects(
			applyIssueClosurePlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			}),
			PlanMismatchError,
		);
	});
});

test("a non-blocking deviation that invalidates resolution remains ineligible and cannot close the issue", async () => {
	await withWorkflow(async (context) => {
		await link(context, "resolves");
		await completeNoCodeWorkflow(context, {
			deviations: [{
				blocking: false,
				description: "The delivered behavior omits the issue's required migration path.",
			}],
		});
		const unresolved = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(unresolved.eligible, false);
		assert.equal(unresolved.deviation_review.status, "not_established");
		assert.ok(unresolved.reasons.some(({ code }) => code === "deviation_effect_not_established"));
		const invalidating = deviationDetermination(
			unresolved,
			"invalidates_resolution",
			"The omitted migration path is required for this issue to be resolved.",
		);
		const eligibility = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
			deviationDetermination: invalidating,
		});
		assert.equal(eligibility.eligible, false);
		assert.equal(eligibility.deviation_review.status, "invalidates_resolution");
		assert.ok(eligibility.reasons.some(({ code }) => code === "deviation_invalidates_issue_resolution"));
		await assert.rejects(
			createIssueClosurePlan(context.identity, context.workflowId, context.issueId, {
				homeDirectory: context.homeDirectory,
				deviationDetermination: invalidating,
			}),
			(error) => {
				assert.equal(error instanceof IssueAdapterError, true);
				assert.equal(error.details.deviation_review.deviations[0].description, "The delivered behavior omits the issue's required migration path.");
				assert.equal(error.details.deviation_review.determination.effects[0].effect, "invalidates_resolution");
				return true;
			},
		);
		assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
	});
});

test("closure plans expose exact safe deviation determinations and reject changed evidence", async () => {
	await withWorkflow(async (context) => {
		const description = "The optional legacy report uses the previous visual formatting.";
		await link(context, "resolves");
		await completeNoCodeWorkflow(context, {
			deviations: [{ blocking: false, description }],
		});
		const unresolved = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		const safe = deviationDetermination(
			unresolved,
			"does_not_invalidate_resolution",
			"The linked issue does not require the optional legacy report's visual formatting.",
		);
		const eligible = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
			deviationDetermination: safe,
		});
		assert.equal(eligible.eligible, true);
		assert.equal(eligible.deviation_review.status, "does_not_invalidate_resolution");
		const plan = await createIssueClosurePlan(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
			deviationDetermination: safe,
		});
		assert.equal(plan.deviation_review.deviations[0].description, description);
		assert.deepEqual(plan.deviation_review.determination, safe);
		const source = await readFile(plan.verification.path, "utf8");
		await writeFile(
			plan.verification.path,
			source.replace(description, "The legacy report is now omitted entirely."),
			"utf8",
		);
		await assert.rejects(
			applyIssueClosurePlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			}),
			PlanMismatchError,
		);
		assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
	});
});

test("partial, related, and cancelled workflows leave linked issues open and ineligible", async () => {
	for (const relation of ["partially-addresses", "related"]) {
		await withWorkflow(async (context) => {
			await link(context, relation);
			const eligibility = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
				homeDirectory: context.homeDirectory,
			});
			assert.equal(eligibility.eligible, false);
			assert.ok(eligibility.reasons.some(({ code }) => code === "relation_not_resolves"));
			assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
		});
	}
	await withWorkflow(async (context) => {
		await link(context, "resolves");
		const workflow = await inspectWorkflow(context.identity, context.workflowId, { homeDirectory: context.homeDirectory });
		await cancelWorkflow(context.identity, context.workflowId, "The initiative was intentionally cancelled.", {
			expectedDigest: workflow.digest,
			homeDirectory: context.homeDirectory,
		});
		const eligibility = await evaluateIssueClosureEligibility(context.identity, context.workflowId, context.issueId, {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(eligibility.eligible, false);
		assert.ok(eligibility.reasons.some(({ code }) => code === "workflow_cancelled"));
		assert.equal((await inspectLinkedIssue(context.identity, context.issueId)).status, "open");
	});
});
