import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	ConfirmationRequiredError,
	GitStateError,
	PlanMismatchError,
} from "./errors.mjs";
import {
	applyFinalIntegrationPlan,
	applyTicketIntegrationPlan,
	applyTicketReconciliationPlan,
	applyTicketWorktreePlan,
	applyTicketWorktreeRemovalPlan,
	applyWorkflowBranchPlan,
	createFinalIntegrationPlan,
	createTicketIntegrationPlan,
	createTicketReconciliationPlan,
	createTicketWorktreePlan,
	createTicketWorktreeRemovalPlan,
	createWorkflowBranchPlan,
} from "./git-plans.mjs";
import {
	checkFinalContainment,
	resolveLocalBranchCommit,
	ticketBranchName,
	workflowBranchName,
} from "./git-operations.mjs";

const execFileAsync = promisify(execFile);
const WORKFLOW_ID = "WF-0001";
const WORKFLOW_SLUG = "deliver-feature";
const TICKET_ID = "T-0001";
const TICKET_SLUG = "implement-feature";

async function withRepository(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-git-plans-test-"));
	const repository = resolve(directory, "project");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "workflows-test@example.invalid");
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
		await run({ directory, repository });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function commitFile(repository, name, content, message, trailers) {
	await writeFile(resolve(repository, name), content);
	await git(repository, "add", "--", name);
	const argumentsList = ["commit", "--quiet", "-m", message];
	if (trailers !== undefined) argumentsList.push("-m", trailers);
	await git(repository, ...argumentsList);
	return git(repository, "rev-parse", "HEAD");
}

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function assertPathMissing(path) {
	await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("workflow branch creation is reviewed, authorized, and stale-base guarded", async () => {
	await withRepository(async ({ repository }) => {
		const plan = await createWorkflowBranchPlan({
			cwd: repository,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
		});
		const branch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
		assert.equal(plan.action, "create_and_switch");
		assert.equal(await resolveLocalBranchCommit(repository, branch), null);
		await assert.rejects(applyWorkflowBranchPlan(plan), ConfirmationRequiredError);
		assert.equal(await resolveLocalBranchCommit(repository, branch), null);

		const result = await applyWorkflowBranchPlan(plan, { authorization: authorization(plan) });
		assert.equal(result.branch, branch);
		assert.equal(await git(repository, "branch", "--show-current"), branch);
		assert.equal(result.commit, plan.base_commit);
	});

	await withRepository(async ({ repository }) => {
		const plan = await createWorkflowBranchPlan({
			cwd: repository,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
		});
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "base moved");
		await assert.rejects(
			applyWorkflowBranchPlan(plan, { authorization: authorization(plan) }),
			PlanMismatchError,
		);
		assert.equal(
			await resolveLocalBranchCommit(repository, workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG)),
			null,
		);
	});
});

test("workflow branch planning rejects dirty trees, ref namespace conflicts, and adoption mismatches", async (t) => {
	await t.test("dirty worktree", async () => {
		await withRepository(async ({ repository }) => {
			await writeFile(resolve(repository, "untracked.txt"), "keep\n");
			await assert.rejects(
				createWorkflowBranchPlan({
					cwd: repository,
					workflowId: WORKFLOW_ID,
					workflowSlug: WORKFLOW_SLUG,
				}),
				(error) => error instanceof GitStateError && /must be clean/u.test(error.message),
			);
		});
	});

	await t.test("ref namespace conflict", async () => {
		await withRepository(async ({ repository }) => {
			await git(repository, "branch", "dbz-workflows");
			await assert.rejects(
				createWorkflowBranchPlan({
					cwd: repository,
					workflowId: WORKFLOW_ID,
					workflowSlug: WORKFLOW_SLUG,
				}),
				(error) => error instanceof GitStateError && /ref namespace/u.test(error.message),
			);
		});
	});

	await t.test("existing branch adoption mismatch", async () => {
		await withRepository(async ({ repository }) => {
			const branch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
			await git(repository, "branch", branch);
			await assert.rejects(
				createWorkflowBranchPlan({
					cwd: repository,
					workflowId: WORKFLOW_ID,
					workflowSlug: WORKFLOW_SLUG,
					adoptExistingCommit: "0".repeat(40),
				}),
				(error) => error instanceof GitStateError && /does not match/u.test(error.message),
			);
			assert.equal(await git(repository, "branch", "--show-current"), "main");
		});
	});
});

test("ticket worktree reconciliation reports rebased OIDs and integration discovers final commits", async () => {
	await withRepository(async ({ directory, repository }) => {
		const workflowBranch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
		const ticketBranch = ticketBranchName(WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
		const worktreePath = resolve(directory, "ticket-worktree");
		await git(repository, "switch", "-c", workflowBranch);
		const ticketPlan = await createTicketWorktreePlan({
			cwd: repository,
			worktreePath,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			ticketId: TICKET_ID,
			ticketSlug: TICKET_SLUG,
		});
		assert.equal(ticketPlan.action, "create_branch_and_worktree");
		await assertPathMissing(worktreePath);
		await applyTicketWorktreePlan(ticketPlan, { authorization: authorization(ticketPlan) });
		assert.equal(await git(worktreePath, "branch", "--show-current"), ticketBranch);

		const ticketCommitBeforeRebase = await commitFile(
			worktreePath,
			"ticket.txt",
			"ticket\n",
			"feat: implement ticket",
			`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}`,
		);
		const workflowAdvance = await commitFile(
			repository,
			"workflow.txt",
			"workflow advance\n",
			"chore: advance workflow",
		);
		const reconciliationPlan = await createTicketReconciliationPlan({
			worktreePath,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			ticketId: TICKET_ID,
			ticketSlug: TICKET_SLUG,
		});
		assert.equal(reconciliationPlan.action, "rebase_ticket");
		const reconciliation = await applyTicketReconciliationPlan(reconciliationPlan, {
			authorization: authorization(reconciliationPlan),
		});
		assert.notEqual(reconciliation.ticket_commit, ticketCommitBeforeRebase);
		assert.equal(reconciliation.workflow_commit, workflowAdvance);
		assert.deepEqual(reconciliation.previous_ticket_commits, [ticketCommitBeforeRebase]);
		assert.deepEqual(reconciliation.ticket_commits, [reconciliation.ticket_commit]);

		const integrationPlan = await createTicketIntegrationPlan({
			cwd: repository,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			ticketId: TICKET_ID,
			ticketSlug: TICKET_SLUG,
		});
		assert.deepEqual(integrationPlan.ticket.commits, [reconciliation.ticket_commit]);
		const integration = await applyTicketIntegrationPlan(integrationPlan, {
			authorization: authorization(integrationPlan),
		});
		assert.deepEqual(integration.integrated_commits, [reconciliation.ticket_commit]);
		assert.equal(integration.workflow_commit, reconciliation.ticket_commit);
		assert.equal(integration.integrated_commits.includes(ticketCommitBeforeRebase), false);

		const removalPlan = await createTicketWorktreeRemovalPlan({
			cwd: repository,
			worktreePath,
			workflowId: WORKFLOW_ID,
			ticketId: TICKET_ID,
			ticketSlug: TICKET_SLUG,
			removeBranch: true,
			containedInBranch: workflowBranch,
		});
		await applyTicketWorktreeRemovalPlan(removalPlan, {
			authorization: authorization(removalPlan),
		});
		await assertPathMissing(worktreePath);
		assert.equal(await resolveLocalBranchCommit(repository, ticketBranch), null);
	});
});

test("ticket integration rejects missing trailers and stale reviewed branch tips", async (t) => {
	await t.test("missing trailers", async () => {
		await withRepository(async ({ repository }) => {
			const workflowBranch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
			const ticketBranch = ticketBranchName(WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
			await git(repository, "switch", "-c", workflowBranch);
			await git(repository, "switch", "-c", ticketBranch);
			await commitFile(repository, "missing.txt", "missing\n", "missing ticket trailers");
			await git(repository, "switch", workflowBranch);
			await assert.rejects(
				createTicketIntegrationPlan({
					cwd: repository,
					workflowId: WORKFLOW_ID,
					workflowSlug: WORKFLOW_SLUG,
					ticketId: TICKET_ID,
					ticketSlug: TICKET_SLUG,
				}),
				(error) => error instanceof GitStateError && /exactly one/u.test(error.message),
			);
		});
	});

	await t.test("stale ticket tip", async () => {
		await withRepository(async ({ repository }) => {
			const workflowBranch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
			const ticketBranch = ticketBranchName(WORKFLOW_ID, TICKET_ID, TICKET_SLUG);
			await git(repository, "switch", "-c", workflowBranch);
			await git(repository, "switch", "-c", ticketBranch);
			await commitFile(
				repository,
				"one.txt",
				"one\n",
				"first ticket commit",
				`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}`,
			);
			await git(repository, "switch", workflowBranch);
			const plan = await createTicketIntegrationPlan({
				cwd: repository,
				workflowId: WORKFLOW_ID,
				workflowSlug: WORKFLOW_SLUG,
				ticketId: TICKET_ID,
				ticketSlug: TICKET_SLUG,
			});
			await git(repository, "switch", ticketBranch);
			await commitFile(
				repository,
				"two.txt",
				"two\n",
				"second ticket commit",
				`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}`,
			);
			await git(repository, "switch", workflowBranch);
			await assert.rejects(
				applyTicketIntegrationPlan(plan, { authorization: authorization(plan) }),
				PlanMismatchError,
			);
			assert.equal(await git(repository, "rev-parse", "HEAD"), plan.workflow.commit);
		});
	});
});

test("final integration permits only reviewed pending project-storage artifacts from the workflow branch", async () => {
	await withRepository(async ({ repository }) => {
		const workflowBranch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
		await git(repository, "switch", "-c", workflowBranch);
		const delivered = await commitFile(repository, "delivered.txt", "delivered\n", "deliver workflow");
		const storageRoot = resolve(repository, "dbz-workflows");
		await mkdir(storageRoot);
		await writeFile(resolve(storageRoot, "verification.md"), "pending canonical evidence\n", "utf8");
		const plan = await createFinalIntegrationPlan({
			cwd: repository,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			targetBranch: "main",
			allowedDirtyRoot: storageRoot,
		});
		assert.equal(plan.action, "fast_forward_target_ref");
		assert.equal(plan.source.allowed_dirty.entry_count, 1);
		const result = await applyFinalIntegrationPlan(plan, { authorization: authorization(plan) });
		assert.equal(result.contained, true);
		assert.equal(await git(repository, "rev-parse", "main"), delivered);
		assert.equal((await lstat(resolve(storageRoot, "verification.md"))).isFile(), true);

		await writeFile(resolve(repository, "unexpected.txt"), "unexpected\n", "utf8");
		await assert.rejects(
			createFinalIntegrationPlan({
				cwd: repository,
				workflowId: WORKFLOW_ID,
				workflowSlug: WORKFLOW_SLUG,
				targetBranch: "main",
				allowedDirtyRoot: storageRoot,
			}),
			GitStateError,
		);
	});
});

test("final integration planning never merges and apply requires exact reviewed authorization", async () => {
	await withRepository(async ({ repository }) => {
		const initial = await git(repository, "rev-parse", "HEAD");
		const workflowBranch = workflowBranchName(WORKFLOW_ID, WORKFLOW_SLUG);
		await git(repository, "switch", "-c", workflowBranch);
		const delivered = await commitFile(repository, "delivered.txt", "delivered\n", "deliver workflow");
		await git(repository, "switch", "main");
		const plan = await createFinalIntegrationPlan({
			cwd: repository,
			workflowId: WORKFLOW_ID,
			workflowSlug: WORKFLOW_SLUG,
			targetBranch: "main",
		});
		assert.equal(plan.action, "fast_forward_target");
		assert.equal(await git(repository, "rev-parse", "main"), initial);
		assert.equal((await checkFinalContainment(repository, {
			deliveredCommit: delivered,
			targetBranch: "main",
		})).contained, false);

		await assert.rejects(applyFinalIntegrationPlan(plan), ConfirmationRequiredError);
		await assert.rejects(
			applyFinalIntegrationPlan(plan, {
				authorization: { confirmed: true, planDigest: "0".repeat(64) },
			}),
			ConfirmationRequiredError,
		);
		assert.equal(await git(repository, "rev-parse", "main"), initial);

		const result = await applyFinalIntegrationPlan(plan, { authorization: authorization(plan) });
		assert.equal(result.contained, true);
		assert.equal(result.target_commit, delivered);
		assert.equal(await git(repository, "rev-parse", "main"), delivered);
	});
});
