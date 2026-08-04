import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	ConfirmationRequiredError,
	PlanMismatchError,
	RevisionConflictError,
	SchemaValidationError,
	WorkflowError,
} from "./errors.mjs";
import { readFileWithDigest } from "./filesystem.mjs";
import { parseFrontmatter, patchFrontmatter } from "./frontmatter.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { parseRootManifest, resolveActiveStorage } from "./storage.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import {
	applyWorkflowReservationPlan,
	applyWorkflowStartPlan,
	cancelWorkflow,
	createWorkflowReservationPlan,
	createWorkflowStartPlan,
	formatWorkflowId,
	generateImmutableSlug,
	inspectWorkflow,
	listWorkflows,
	setWorkflowCondition,
	setWorkflowIssueLinks,
	transitionWorkflowPhase,
	updateWorkflowTitle,
	validateWorkflowContinuation,
	workflowDirectoryName,
} from "./workflows.mjs";

const execFileAsync = promisify(execFile);
const TIMESTAMP_1 = "2026-08-03T15:30:00.000Z";
const TIMESTAMP_2 = "2026-08-03T16:00:00.000Z";
const CLOCK_1 = () => new Date(TIMESTAMP_1);
const CLOCK_2 = () => new Date(TIMESTAMP_2);

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function withRepository(mode, run) {
	const directory = await mkdtemp(resolve(tmpdir(), `dbz-workflows-${mode}-lifecycle-test-`));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "isolated-home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "workflows-test@example.invalid");
		await git(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
		const identity = await inspectGitProject(repository);
		const setupPlan = await createSetupPlan(identity, {
			mode,
			homeDirectory,
			clock: CLOCK_1,
		});
		await applySetupPlan(setupPlan, {
			identity,
			homeDirectory,
			authorization: authorization(setupPlan),
		});
		if (mode === "project") {
			await git(repository, "add", "--", "dbz-workflows/dbz-workflows.md");
			await git(repository, "commit", "--quiet", "-m", "chore: configure workflows");
		}
		await run({ directory, repository, homeDirectory, identity: await inspectGitProject(repository) });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function authorization(plan) {
	return { confirmed: true, planDigest: plan.plan_digest };
}

async function reserve(context, title = "Add OAuth authentication", options = {}) {
	const plan = await createWorkflowReservationPlan(context.identity, {
		title,
		baseBranch: context.mode === "project" ? "main" : undefined,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_1,
	});
	const result = await applyWorkflowReservationPlan(plan, {
		identity: context.identity,
		homeDirectory: context.homeDirectory,
		authorization: authorization(plan),
		...options,
	});
	return { plan, result, reservation: result.reservation };
}

async function start(context, reservation, initialIdea = "Users need standards-compliant OAuth sign-in.") {
	context.identity = await inspectGitProject(context.repository);
	const plan = await createWorkflowStartPlan(context.identity, {
		reservation,
		initialIdea,
		homeDirectory: context.homeDirectory,
		clock: CLOCK_2,
	});
	const result = await applyWorkflowStartPlan(plan, {
		identity: context.identity,
		homeDirectory: context.homeDirectory,
		authorization: authorization(plan),
	});
	context.identity = await inspectGitProject(context.repository);
	return { plan, result };
}

test("formats immutable workflow IDs and safe deterministic slugs", () => {
	assert.equal(formatWorkflowId(1), "WF-0001");
	assert.equal(formatWorkflowId(10_000), "WF-10000");
	assert.equal(generateImmutableSlug("  Déjà Vu: OAuth & SSO!  "), "deja-vu-oauth-sso");
	assert.equal(generateImmutableSlug("日本語"), "workflow");
	assert.equal(generateImmutableSlug("one two three", { maxLength: 7 }), "one-two");
	assert.equal(workflowDirectoryName("WF-0001", "stable-slug"), "WF-0001-stable-slug");
});

test("managed workflow creation reserves IDs, creates exact artifacts, and records the Git base", async () => {
	await withRepository("managed", async (context) => {
		context.mode = "managed";
		const originalCommit = context.identity.headCommit;
		const { plan: reservationPlan, reservation } = await reserve(context);
		assert.equal(reservation.workflow.id, "WF-0001");
		assert.equal(reservation.base_commit, originalCommit);
		assert.equal(reservation.base_branch, "main");
		assert.equal(reservation.reservation_commit, null);

		const storage = await resolveActiveStorage(context.identity, { homeDirectory: context.homeDirectory });
		const rootSource = await readFile(resolve(storage.effectivePath, "dbz-workflows.md"), "utf8");
		assert.equal(parseRootManifest(rootSource).metadata.next_workflow_number, 2);
		await assert.rejects(
			applyWorkflowReservationPlan(reservationPlan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(reservationPlan),
			}),
			PlanMismatchError,
		);

		const { plan, result } = await start(context, reservation, "First line.\n\nSecond line.");
		assert.equal(result.branch.branch, "dbz-workflows/WF-0001-add-oauth-authentication");
		assert.equal(result.branch.commit, originalCommit);
		assert.equal(await git(context.repository, "branch", "--show-current"), result.branch.branch);
		assert.equal(result.workflow.metadata.git.base_branch, "main");
		assert.equal(result.workflow.metadata.git.base_commit, originalCommit);
		assert.equal(result.workflow.metadata.git.workflow_branch, result.branch.branch);
		assert.equal(result.workflow.metadata.phase, "discovery");
		assert.deepEqual(result.workflow.metadata.conditions, []);
		assert.deepEqual(result.workflow.metadata.issues, []);
		assert.equal(plan.artifacts.directory, resolve(storage.effectivePath, "WF-0001-add-oauth-authentication"));
		const spec = await readFile(plan.artifacts.spec.path, "utf8");
		assert.equal(parseFrontmatter(spec).data.status, "draft");
		assert.match(spec, /> First line\.\n> \n> Second line\./u);
		for (const path of plan.artifacts.directories) {
			assert.equal((await stat(path)).isDirectory(), true);
			assert.ok(path.startsWith(plan.artifacts.directory));
		}
		const listed = await listWorkflows(context.identity, { homeDirectory: context.homeDirectory });
		assert.equal(listed.length, 1);
		assert.equal(listed[0].id, "WF-0001");
		assert.equal(Object.hasOwn(listed[0], "body"), false);
	});
});

test("project-mode reservation is a confirmed dedicated base commit and workflow branches from it", async () => {
	await withRepository("project", async (context) => {
		context.mode = "project";
		const before = await git(context.repository, "rev-parse", "HEAD");
		const plan = await createWorkflowReservationPlan(context.identity, {
			title: "Project workflow",
			baseBranch: "main",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_1,
		});
		await assert.rejects(
			applyWorkflowReservationPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
			}),
			ConfirmationRequiredError,
		);
		assert.equal(await git(context.repository, "rev-parse", "HEAD"), before);

		const applied = await applyWorkflowReservationPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		const reservationCommit = applied.reservation.reservation_commit;
		assert.notEqual(reservationCommit, before);
		assert.equal(await git(context.repository, "rev-parse", "HEAD^"), before);
		assert.equal(await git(context.repository, "branch", "--show-current"), "main");
		assert.equal(
			await git(context.repository, "show", "--format=%s", "--no-patch", "HEAD"),
			"chore(dbz-workflows): reserve WF-0001",
		);
		assert.equal(
			await git(context.repository, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"),
			"dbz-workflows/dbz-workflows.md",
		);
		assert.equal(await git(context.repository, "status", "--porcelain"), "");

		context.identity = await inspectGitProject(context.repository);
		const { result } = await start(context, applied.reservation);
		assert.equal(result.workflow.metadata.git.base_branch, "main");
		assert.equal(result.workflow.metadata.git.base_commit, reservationCommit);
		assert.equal(result.branch.commit, reservationCommit);
		assert.equal(await git(context.repository, "branch", "--show-current"), result.branch.branch);
		assert.match(await git(context.repository, "status", "--porcelain"), /^\?\? dbz-workflows\/WF-0001-project-workflow\//u);
	});
});

test("project-mode reservation restores an uncommitted counter when Git rejects the confirmed commit", async () => {
	await withRepository("project", async (context) => {
		context.mode = "project";
		const storage = await resolveActiveStorage(context.identity, { homeDirectory: context.homeDirectory });
		const rootPath = resolve(storage.effectivePath, "dbz-workflows.md");
		const beforeSource = await readFile(rootPath, "utf8");
		const beforeCommit = await git(context.repository, "rev-parse", "HEAD");
		const hookPath = resolve(context.repository, ".git", "hooks", "pre-commit");
		await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const plan = await createWorkflowReservationPlan(context.identity, {
			title: "Rejected reservation",
			baseBranch: "main",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_1,
		});
		await assert.rejects(
			applyWorkflowReservationPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			}),
			(error) => error instanceof WorkflowError && error.details.restored === true,
		);
		assert.equal(await readFile(rootPath, "utf8"), beforeSource);
		assert.equal(await git(context.repository, "rev-parse", "HEAD"), beforeCommit);
		assert.equal(await git(context.repository, "status", "--porcelain"), "");
		await rm(hookPath);
		const retry = await createWorkflowReservationPlan(context.identity, {
			title: "Retry reservation",
			baseBranch: "main",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		assert.equal(retry.workflow.id, "WF-0001");
	});
});

test("project-mode reservation serializes competing plans and never reuses the consumed ID", async () => {
	await withRepository("project", async (context) => {
		context.mode = "project";
		const options = {
			title: "Synchronized workflow",
			baseBranch: "main",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_1,
		};
		const [left, right] = await Promise.all([
			createWorkflowReservationPlan(context.identity, options),
			createWorkflowReservationPlan(context.identity, options),
		]);
		const results = await Promise.allSettled([
			applyWorkflowReservationPlan(left, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(left),
			}),
			applyWorkflowReservationPlan(right, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(right),
			}),
		]);
		assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
		assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
		assert.ok(results.find(({ status }) => status === "rejected").reason instanceof PlanMismatchError);

		context.identity = await inspectGitProject(context.repository);
		const next = await createWorkflowReservationPlan(context.identity, {
			title: "Next workflow",
			baseBranch: "main",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		assert.equal(next.workflow.id, "WF-0002");
	});
});

test("project-mode creation rejects dirty trees and detached reservation bases", async (t) => {
	await t.test("dirty", async () => {
		await withRepository("project", async (context) => {
			await writeFile(resolve(context.repository, "untracked.txt"), "keep\n");
			await assert.rejects(
				createWorkflowReservationPlan(context.identity, {
					title: "Dirty workflow",
					baseBranch: "main",
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof WorkflowError || /must be clean/u.test(error.message),
			);
		});
	});
	await t.test("detached", async () => {
		await withRepository("project", async (context) => {
			await git(context.repository, "checkout", "--quiet", "--detach");
			context.identity = await inspectGitProject(context.repository);
			await assert.rejects(
				createWorkflowReservationPlan(context.identity, {
					title: "Detached workflow",
					baseBranch: "main",
					homeDirectory: context.homeDirectory,
				}),
				(error) => error instanceof WorkflowError && /detached HEAD/u.test(error.message),
			);
		});
	});
});

test("existing workflow branches are adopted only with matching canonical metadata and an exact commit", async () => {
	await withRepository("managed", async (context) => {
		context.mode = "managed";
		const { reservation } = await reserve(context, "Adoptable workflow");
		const { result } = await start(context, reservation);
		const workflowDigest = result.workflow.digest;
		const existingCommit = await git(context.repository, "rev-parse", result.branch.branch);
		await git(context.repository, "switch", "main");
		context.identity = await inspectGitProject(context.repository);
		await assert.rejects(
			createWorkflowStartPlan(context.identity, {
				reservation,
				initialIdea: "Must not overwrite the existing canonical workflow.",
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof WorkflowError && /will not be overwritten/u.test(error.message),
		);
		await assert.rejects(
			createWorkflowStartPlan(context.identity, {
				reservation,
				initialIdea: "Try invalid adoption.",
				adoptExistingCommit: "0".repeat(40),
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof WorkflowError || /does not match/u.test(error.message),
		);
		const adoptionPlan = await createWorkflowStartPlan(context.identity, {
			reservation,
			initialIdea: "Canonical content already exists.",
			adoptExistingCommit: existingCommit,
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		assert.equal(adoptionPlan.action, "adopt_existing");
		const adopted = await applyWorkflowStartPlan(adoptionPlan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(adoptionPlan),
		});
		assert.equal(adopted.action, "adopt_existing");
		assert.deepEqual(adopted.created_files, []);
		assert.equal(adopted.workflow.digest, workflowDigest);
		assert.equal(await git(context.repository, "branch", "--show-current"), result.branch.branch);
	});
});

test("workflow titles, paths, and slugs are stable while lifecycle mutations are revision guarded", async () => {
	await withRepository("managed", async (context) => {
		context.mode = "managed";
		const { reservation } = await reserve(context, "Stable path");
		await start(context, reservation);
		let workflow = await inspectWorkflow(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		});
		const originalDirectory = workflow.directory;
		const originalSlug = workflow.slug;
		const originalSource = await readFile(workflow.path, "utf8");
		const withUnknown = patchFrontmatter(originalSource, [
			{ path: ["future_extension"], value: { retained: true } },
		]);
		await writeFile(workflow.path, withUnknown);
		workflow = await inspectWorkflow(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		});
		const beforeBody = parseFrontmatter(withUnknown).body;
		const renamed = await updateWorkflowTitle(context.identity, "WF-0001", "A renamed workflow", {
			homeDirectory: context.homeDirectory,
			expectedDigest: workflow.digest,
			clock: CLOCK_2,
		});
		assert.equal(renamed.workflow.title, "A renamed workflow");
		assert.equal(renamed.workflow.slug, originalSlug);
		assert.equal(renamed.workflow.directory, originalDirectory);
		assert.deepEqual(renamed.workflow.metadata.future_extension, { retained: true });
		assert.equal(parseFrontmatter(await readFile(renamed.workflow.path, "utf8")).body, beforeBody);
		await assert.rejects(
			transitionWorkflowPhase(context.identity, "WF-0001", "planning", {
				homeDirectory: context.homeDirectory,
				expectedDigest: workflow.digest,
			}),
			RevisionConflictError,
		);
	});
});

test("phase, condition, cancellation, continuation, and issue-link rules are enforced", async () => {
	await withRepository("managed", async (context) => {
		context.mode = "managed";
		const { reservation } = await reserve(context, "Lifecycle workflow");
		await start(context, reservation);
		let workflow = await inspectWorkflow(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		});
		await assert.rejects(
			transitionWorkflowPhase(context.identity, "WF-0001", "ready", {
				homeDirectory: context.homeDirectory,
				expectedDigest: workflow.digest,
			}),
			(error) => error instanceof WorkflowError && error.code === "invalid_workflow_transition",
		);
		await assert.rejects(
			transitionWorkflowPhase(context.identity, "WF-0001", "planning", {
				homeDirectory: context.homeDirectory,
				expectedDigest: workflow.digest,
				clock: CLOCK_2,
			}),
			(error) => error instanceof WorkflowError && /baseline approval/u.test(error.message),
		);
		await assert.rejects(
			setWorkflowCondition(context.identity, "WF-0001", "awaiting-integration", true, {
				homeDirectory: context.homeDirectory,
				expectedDigest: workflow.digest,
			}),
			SchemaValidationError,
		);
		workflow = (await setWorkflowCondition(context.identity, "WF-0001", "blocked", true, {
			homeDirectory: context.homeDirectory,
			expectedDigest: workflow.digest,
		})).workflow;
		assert.deepEqual(workflow.conditions, ["blocked"]);
		workflow = (await setWorkflowIssueLinks(
			context.identity,
			"WF-0001",
			[
				{ id: "ISSUE-001", relation: "resolves" },
				{ id: "014-add-docs", relation: "partially-addresses" },
			],
			{ homeDirectory: context.homeDirectory, expectedDigest: workflow.digest },
		)).workflow;
		assert.deepEqual(workflow.issues, [
			{ id: "ISSUE-001", relation: "resolves" },
			{ id: "014-add-docs", relation: "partially-addresses" },
		]);
		await assert.rejects(
			setWorkflowIssueLinks(
				context.identity,
				"WF-0001",
				[
					{ id: "ISSUE-001", relation: "related" },
					{ id: "ISSUE-001", relation: "resolves" },
				],
				{ homeDirectory: context.homeDirectory, expectedDigest: workflow.digest },
			),
			SchemaValidationError,
		);

		const continuation = await validateWorkflowContinuation(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		});
		assert.equal(continuation.requires_branch_switch, false);
		await git(context.repository, "switch", "main");
		context.identity = await inspectGitProject(context.repository);
		assert.equal((await validateWorkflowContinuation(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		})).requires_branch_switch, true);

		workflow = await inspectWorkflow(context.identity, "WF-0001", {
			homeDirectory: context.homeDirectory,
		});
		workflow = (await cancelWorkflow(context.identity, "WF-0001", "The initiative was withdrawn.", {
			homeDirectory: context.homeDirectory,
			expectedDigest: workflow.digest,
			clock: CLOCK_2,
		})).workflow;
		assert.equal(workflow.phase, "cancelled");
		assert.deepEqual(workflow.conditions, []);
		assert.deepEqual(workflow.metadata.cancellation, {
			rationale: "The initiative was withdrawn.",
			cancelled_at: TIMESTAMP_2,
		});
		await assert.rejects(
			validateWorkflowContinuation(context.identity, "WF-0001", {
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof WorkflowError && /terminal/u.test(error.message),
		);
	});
});

test("managed reservations burn numbers even before workflow branch creation", async () => {
	await withRepository("managed", async (context) => {
		context.mode = "managed";
		const first = await reserve(context, "Reserved but not started");
		context.identity = await inspectGitProject(context.repository);
		const secondPlan = await createWorkflowReservationPlan(context.identity, {
			title: "Second reservation",
			homeDirectory: context.homeDirectory,
			clock: CLOCK_2,
		});
		assert.equal(first.reservation.workflow.id, "WF-0001");
		assert.equal(secondPlan.workflow.id, "WF-0002");
		const snapshot = await readFileWithDigest(
			resolve((await resolveActiveStorage(context.identity, { homeDirectory: context.homeDirectory })).effectivePath, "dbz-workflows.md"),
			{ encoding: "utf8" },
		);
		assert.equal(parseRootManifest(snapshot.data).metadata.next_workflow_number, 2);
	});
});
