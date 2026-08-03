import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitStateError, ValidationError } from "./errors.mjs";
import {
	assertCleanWorktree,
	assertFinalContainment,
	assertTicketCommitTrailers,
	checkFinalContainment,
	inspectTicketCommitTrailers,
	inspectWorktreeStatus,
	ticketBranchName,
	workflowBranchName,
} from "./git-operations.mjs";

const execFileAsync = promisify(execFile);
const WORKFLOW_ID = "WF-0001";
const TICKET_ID = "T-0007";

async function withRepository(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-git-operations-test-"));
	const repository = resolve(directory, "project with spaces");
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

test("derives only canonical workflow and ticket branch names", () => {
	assert.equal(
		workflowBranchName("WF-0001", "add-oauth-authentication"),
		"dbz-workflows/WF-0001-add-oauth-authentication",
	);
	assert.equal(
		ticketBranchName("WF-0001", "T-0007", "implement-provider"),
		"dbz-tickets/WF-0001/T-0007-implement-provider",
	);
	for (const invalid of ["WF-0000", "WF-1", "wf-0001", "WF-00001"]) {
		assert.throws(() => workflowBranchName(invalid, "valid-slug"), ValidationError);
	}
	for (const invalidSlug of ["", "Uppercase", "../escape", "two--parts", "ends-"]) {
		assert.throws(() => workflowBranchName("WF-0001", invalidSlug), ValidationError);
	}
});

test("clean-worktree checks include tracked and untracked changes without returning file bodies", async () => {
	await withRepository(async ({ repository }) => {
		assert.equal((await assertCleanWorktree(repository)).clean, true);
		await writeFile(resolve(repository, "untracked.txt"), "untracked content that must not be returned\n");
		const status = await inspectWorktreeStatus(repository);
		assert.equal(status.clean, false);
		assert.equal(status.entryCount, 1);
		assert.deepEqual(status.statusCodes, ["??"]);
		assert.equal(Object.hasOwn(status, "output"), false);
		await assert.rejects(
			assertCleanWorktree(repository),
			(error) => error instanceof GitStateError && /must be clean/u.test(error.message),
		);
	});
});

test("validates exact commit trailers and rejects missing or duplicate values", async () => {
	await withRepository(async ({ repository }) => {
		const missing = await commitFile(repository, "missing.txt", "missing\n", "missing trailers");
		const valid = await commitFile(
			repository,
			"valid.txt",
			"valid\n",
			"valid trailers",
			`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}`,
		);
		const duplicate = await commitFile(
			repository,
			"duplicate.txt",
			"duplicate\n",
			"duplicate trailers",
			`DBZ-Workflow: ${WORKFLOW_ID}\nDBZ-Ticket: ${TICKET_ID}\nDBZ-Ticket: ${TICKET_ID}`,
		);

		assert.equal((await inspectTicketCommitTrailers(repository, valid, {
			workflowId: WORKFLOW_ID,
			ticketId: TICKET_ID,
		})).valid, true);
		assert.equal((await inspectTicketCommitTrailers(repository, missing, {
			workflowId: WORKFLOW_ID,
			ticketId: TICKET_ID,
		})).valid, false);
		await assert.rejects(
			assertTicketCommitTrailers(repository, [missing, duplicate], {
				workflowId: WORKFLOW_ID,
				ticketId: TICKET_ID,
			}),
			(error) => {
				assert.ok(error instanceof GitStateError);
				assert.match(error.message, /exactly one/u);
				assert.equal(error.details.invalid_commits.length, 2);
				return true;
			},
		);
	});
});

test("final containment checks use full commit ancestry", async () => {
	await withRepository(async ({ repository }) => {
		const initial = await git(repository, "rev-parse", "HEAD");
		await git(repository, "branch", "delivered", initial);
		const later = await commitFile(repository, "later.txt", "later\n", "later");
		const contained = await assertFinalContainment(repository, {
			deliveredCommit: initial,
			targetBranch: "main",
		});
		assert.equal(contained.contained, true);
		assert.equal(contained.targetCommit, later);

		await git(repository, "checkout", "--quiet", "delivered");
		const divergent = await commitFile(repository, "divergent.txt", "divergent\n", "divergent");
		await git(repository, "checkout", "--quiet", "main");
		const absent = await checkFinalContainment(repository, {
			deliveredCommit: divergent,
			targetBranch: "main",
		});
		assert.equal(absent.contained, false);
		await assert.rejects(
			assertFinalContainment(repository, { deliveredCommit: divergent, targetBranch: "main" }),
			GitStateError,
		);
	});
});
