import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
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
} from "../skills/dbz-workflows/lib/baselines.mjs";
import {
	createManualExecutorResult,
	startManualExecution,
} from "../skills/dbz-workflows/lib/executors/manual.mjs";
import { inspectGitProject } from "../skills/dbz-workflows/lib/git-identity.mjs";
import { acceptExecutorResult, applyExecutorResult } from "../skills/dbz-workflows/lib/results.mjs";
import { requiredTicketSections } from "../skills/dbz-workflows/lib/schemas/ticket.mjs";
import { applySetupPlan, createSetupPlan } from "../skills/dbz-workflows/lib/setup.mjs";
import { inspectSpec, updateSpecDraftSections } from "../skills/dbz-workflows/lib/specs.mjs";
import {
	externalLocatorPath,
	resolveActiveStorage,
} from "../skills/dbz-workflows/lib/storage.mjs";
import { createTicket, inspectTicket } from "../skills/dbz-workflows/lib/tickets.mjs";
import {
	applyWorkflowFinalIntegrationPlan,
	completeWorkflowAfterIntegration,
	createWorkflowFinalIntegrationPlan,
	inspectVerification,
	recordVerificationOutcome,
	startVerification,
} from "../skills/dbz-workflows/lib/verification.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	inspectWorkflow,
	transitionWorkflowPhase,
} from "../skills/dbz-workflows/lib/workflows.mjs";

const execFileAsync = promisify(execFile);
const CONTEXT_WINDOW_TOKENS = 128_000;

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

function ticketSections(type) {
	return Object.fromEntries(requiredTicketSections(type).map((heading) => [
		heading,
		heading === "Result" ? "" : `${heading} is bounded and has deterministic validation evidence.`,
	]));
}

function doneResult(summary) {
	return {
		outcome: "done",
		summary,
		deliverables: "Every declared deliverable was produced.",
		acceptanceCriteriaEvidence: "Every ticket acceptance criterion has concrete evidence.",
		validation: "Focused deterministic validation passed.",
		deviations: "None.",
		followUps: "None.",
		workerCommits: [],
	};
}

async function completeReadOnlyTicket(context, ticketId, sessionId) {
	const ticket = await inspectTicket(context.identity, context.workflowId, ticketId, {
		homeDirectory: context.homeDirectory,
	});
	const execution = await startManualExecution(context.identity, context.workflowId, ticketId, {
		expectedTicketDigest: ticket.digest,
		sessionId,
		homeDirectory: context.homeDirectory,
		claimIdFactory: () => `${sessionId}-claim`,
		contextWindowTokens: CONTEXT_WINDOW_TOKENS,
	});
	const applied = await applyExecutorResult(
		context.identity,
		context.workflowId,
		ticketId,
		createManualExecutorResult(execution, doneResult(`Completed ${ticketId} in an isolated manual execution context.`)),
		{
			expectedTicketDigest: execution.ticket_digest,
			homeDirectory: context.homeDirectory,
		},
	);
	return acceptExecutorResult(context.identity, context.workflowId, ticketId, {
		deliverables_verified: true,
		acceptance_criteria_verified: true,
		validation_verified: true,
		integrated_commits: [],
	}, {
		expectedTicketDigest: applied.ticket.digest,
		homeDirectory: context.homeDirectory,
	});
}

async function initializeRepository(root, mode) {
	const repository = resolve(root, "project");
	await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
	await git(repository, "config", "user.name", "DBZ Workflows End-to-End Test");
	await git(repository, "config", "user.email", "workflows-e2e@example.invalid");
	await writeFile(resolve(repository, "README.md"), `# ${mode} workflow fixture\n`, "utf8");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "--quiet", "-m", `initial ${mode} fixture`);
	return repository;
}

async function runWorkflow(mode) {
	const root = await mkdtemp(resolve(tmpdir(), `dbz-workflows-${mode}-e2e-`));
	const homeDirectory = resolve(root, "home");
	const externalPath = resolve(root, "selected-external-storage");
	await mkdir(homeDirectory, { recursive: true });
	try {
		const repository = await initializeRepository(root, mode);
		let identity = await inspectGitProject(repository);
		const setupPlan = await createSetupPlan(identity, {
			mode,
			homeDirectory,
			...(mode === "external" ? { externalPath } : {}),
		});
		const setup = await applySetupPlan(setupPlan, {
			identity,
			homeDirectory,
			authorization: authorization(setupPlan),
		});
		assert.equal(setup.mode, mode);
		if (mode === "project") {
			await git(repository, "add", "--", "dbz-workflows/dbz-workflows.md");
			await git(repository, "commit", "--quiet", "-m", "chore: configure DBZ Workflows");
		}

		identity = await inspectGitProject(repository);
		const reservationPlan = await createWorkflowReservationPlan(identity, {
			title: `Deliver a ${mode} storage workflow`,
			homeDirectory,
			...(mode === "project" ? { baseBranch: "main" } : {}),
		});
		const reserved = await applyWorkflowReservationPlan(reservationPlan, {
			identity,
			homeDirectory,
			authorization: authorization(reservationPlan),
		});
		identity = await inspectGitProject(repository);
		const startPlan = await createWorkflowStartPlan(identity, {
			reservation: reserved.reservation,
			initialIdea: "Exercise setup, baseline approval, ticket execution, verification, and completion.",
			homeDirectory,
		});
		await applyWorkflowStartPlan(startPlan, {
			identity,
			homeDirectory,
			authorization: authorization(startPlan),
		});
		identity = await inspectGitProject(repository);

		const workflowId = reserved.reservation.workflow.id;
		const context = { identity, workflowId, homeDirectory, repository };
		let workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		let spec = await inspectSpec(identity, workflowId, { homeDirectory });
		await updateSpecDraftSections(identity, workflowId, [{
			heading: "Acceptance Criteria",
			operation: "append",
			content: "- The complete durable workflow reaches its guarded completed phase.",
		}], {
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			homeDirectory,
		});
		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		spec = await inspectSpec(identity, workflowId, { homeDirectory });
		const baselinePlan = await createBaselineApprovalPlan(identity, workflowId, {
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			homeDirectory,
		});
		await applyBaselineApprovalPlan(baselinePlan, {
			identity,
			homeDirectory,
			authorization: authorization(baselinePlan),
		});

		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		const review = await createTicket(identity, workflowId, {
			title: "Review the durable workflow evidence",
			type: "review",
			status: "open",
			sections: ticketSections("review"),
		}, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory,
			contextWindowTokens: CONTEXT_WINDOW_TOKENS,
		});
		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		const verifier = await createTicket(identity, workflowId, {
			title: "Verify the approved workflow baseline",
			type: "verification",
			status: "open",
			dependsOn: [review.ticket.id],
			sections: ticketSections("verification"),
		}, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory,
			contextWindowTokens: CONTEXT_WINDOW_TOKENS,
		});
		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		workflow = (await transitionWorkflowPhase(identity, workflowId, "ready", {
			expectedDigest: workflow.digest,
			homeDirectory,
		})).workflow;
		workflow = (await transitionWorkflowPhase(identity, workflowId, "execution", {
			expectedDigest: workflow.digest,
			homeDirectory,
		})).workflow;
		assert.equal(workflow.phase, "execution");
		await completeReadOnlyTicket(context, review.ticket.id, `${mode}-review-session`);

		if (mode === "project") {
			await git(repository, "add", "--", "dbz-workflows");
			await git(repository, "commit", "--quiet", "-m", "chore: prepare workflow verification");
			assert.equal(await git(repository, "status", "--porcelain"), "");
			context.identity = identity = await inspectGitProject(repository);
		}

		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		await startVerification(identity, workflowId, {
			expectedWorkflowDigest: workflow.digest,
			homeDirectory,
		});
		await completeReadOnlyTicket(context, verifier.ticket.id, `${mode}-verification-session`);
		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		let verification = await inspectVerification(identity, workflowId, { homeDirectory });
		const recorded = await recordVerificationOutcome(identity, workflowId, {
			outcome: "passed",
			criterionEvidence: [{
				id: "AC-001",
				outcome: "passed",
				evidence: "The end-to-end test exercised every guarded lifecycle operation.",
			}],
			mandatoryTicketEvidence: [
				{ ticket_id: review.ticket.id, evidence: "The coordinator accepted the review result." },
				{ ticket_id: verifier.ticket.id, evidence: "The coordinator accepted the verification result." },
			],
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory,
		});

		if (mode === "project") {
			assert.equal(recorded.workflow.phase, "verification");
			assert.equal(recorded.workflow.conditions.includes("awaiting-integration"), true);
			workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
			verification = await inspectVerification(identity, workflowId, { homeDirectory });
			const integrationPlan = await createWorkflowFinalIntegrationPlan(identity, workflowId, {
				targetBranch: "main",
				expectedWorkflowDigest: workflow.digest,
				expectedVerificationDigest: verification.digest,
				homeDirectory,
			});
			const integrated = await applyWorkflowFinalIntegrationPlan(integrationPlan, {
				identity,
				homeDirectory,
				authorization: authorization(integrationPlan),
			});
			workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
			verification = await inspectVerification(identity, workflowId, { homeDirectory });
			await completeWorkflowAfterIntegration(identity, workflowId, {
				passed: true,
				commands: ["node --test tests/dbz-workflows-e2e.test.mjs"],
				evidence: "The isolated project-mode end-to-end validation passed.",
				validated_commit: integrated.git.target_commit,
			}, {
				expectedWorkflowDigest: workflow.digest,
				expectedVerificationDigest: verification.digest,
				homeDirectory,
			});
		} else {
			assert.equal(recorded.workflow.phase, "completed");
		}

		workflow = await inspectWorkflow(identity, workflowId, { homeDirectory });
		assert.equal(workflow.phase, "completed");
		const storage = await resolveActiveStorage(identity, { homeDirectory });
		assert.equal(storage.mode, mode);
		if (mode === "external") {
			assert.equal(storage.path, externalPath);
			await access(externalLocatorPath(identity.projectKey, { homeDirectory }));
		}
		await access(resolve(workflow.directory, "baselines", "B-0001.md"));
		await access(resolve(workflow.directory, "verification.md"));
		assert.match(await readFile(resolve(workflow.directory, "verification.md"), "utf8"), /outcome: passed/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("all storage modes complete an isolated durable workflow end to end", async (t) => {
	for (const mode of ["project", "managed", "external"]) {
		await t.test(mode, async () => {
			await runWorkflow(mode);
		});
	}
});
