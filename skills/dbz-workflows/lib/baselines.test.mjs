import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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
	beginBaselineRevision,
	createBaselineApprovalPlan,
	deriveBaselineStalenessData,
	inspectBaseline,
	listBaselines,
	parseBaselineArtifact,
} from "./baselines.mjs";
import {
	createDecision,
	inspectDecision,
	listDecisions,
	supersedeDecision,
} from "./decisions.mjs";
import {
	BaselineError,
	ConfirmationRequiredError,
	PlanMismatchError,
	RevisionConflictError,
	SpecError,
	WorkflowError,
} from "./errors.mjs";
import { patchFrontmatter } from "./frontmatter.mjs";
import { inspectGitProject } from "./git-identity.mjs";
import { readLevelTwoSection } from "./markdown.mjs";
import { applySetupPlan, createSetupPlan } from "./setup.mjs";
import {
	applySynthesisUpdate,
	inspectSpec,
	setSpecOpenBlockers,
	updateSpecDraftSections,
	validateSynthesisInputs,
} from "./specs.mjs";
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

async function withWorkflow(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-baseline-test-"));
	const repository = resolve(directory, "project");
	const homeDirectory = resolve(directory, "isolated-home");
	try {
		await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repository]);
		await git(repository, "config", "user.name", "DBZ Workflows Test");
		await git(repository, "config", "user.email", "baseline-test@example.invalid");
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
			title: "Specify OAuth authentication",
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
			initialIdea: "Users need standards-compliant OAuth sign-in.",
			homeDirectory,
			clock: CLOCK_1,
		});
		await applyWorkflowStartPlan(startPlan, {
			identity,
			homeDirectory,
			authorization: authorization(startPlan),
		});
		identity = await inspectGitProject(repository);
		await run({ directory, repository, homeDirectory, identity, workflowId: "WF-0001" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function discoveryTicket(id, type, overrides = {}) {
	return {
		artifact: "ticket",
		id,
		workflow_id: "WF-0001",
		type,
		status: "completed",
		depends_on: [],
		...overrides,
	};
}

const DECISION_INPUT = Object.freeze({
	title: "Use authorization code with PKCE",
	context: "Browser clients need an OAuth flow that does not expose a client secret.",
	consideredOptions: "Authorization code with PKCE; implicit flow; device authorization.",
	decision: "Use authorization code with PKCE for browser sign-in.",
	rationale: "PKCE is standards-based and avoids relying on a browser-held secret.",
	consequences: "The callback and verifier lifecycle must be tested.",
});

test("synthesis validates every completed dependency before exclusively updating selected spec sections", async () => {
	const research = discoveryTicket("T-0001", "research");
	const questions = discoveryTicket("T-0002", "question-session", { unresolved_items: [] });
	const synthesis = discoveryTicket("T-0003", "synthesis", {
		status: "in-progress",
		depends_on: ["T-0001", "T-0002"],
	});
	assert.deepEqual(
		validateSynthesisInputs({
			workflowId: "WF-0001",
			synthesis,
			inputs: [research, questions],
			requiredInputIds: ["T-0001", "T-0002"],
		}),
		{
			synthesis_ticket: "T-0003",
			input_ids: ["T-0001", "T-0002"],
			required_input_ids: ["T-0001", "T-0002"],
		},
	);
	assert.throws(
		() => validateSynthesisInputs({
			workflowId: "WF-0001",
			synthesis: { ...synthesis, depends_on: ["T-0001"] },
			inputs: [research, questions],
		}),
		(error) => error instanceof SpecError && /does not depend/u.test(error.message),
	);
	assert.throws(
		() => validateSynthesisInputs({
			workflowId: "WF-0001",
			synthesis,
			inputs: [research, { ...questions, unresolved_items: ["Select the rollout owner"] }],
		}),
		(error) => error instanceof SpecError && /unresolved/u.test(error.message),
	);

	await withWorkflow(async (context) => {
		let workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const recordedDecision = await createDecision(
			context.identity,
			context.workflowId,
			DECISION_INPUT,
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				clock: CLOCK_1,
			},
		);
		workflow = recordedDecision.workflow;
		const spec = await inspectSpec(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const beforeIdea = readLevelTwoSection(await readFile(spec.path, "utf8"), "Initial Idea");
		const applied = await applySynthesisUpdate(
			context.identity,
			context.workflowId,
			{
				synthesis,
				inputs: [research, questions],
				requiredInputIds: ["T-0001", "T-0002"],
				decisions: [recordedDecision.decision],
				sectionUpdates: [
					{ operation: "append", heading: "Problem", content: "OAuth sign-in is currently unavailable." },
				],
				openBlockers: [],
			},
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
				clock: CLOCK_2,
			},
		);
		assert.equal(applied.spec.metadata.last_synthesis_ticket, "T-0003");
		assert.deepEqual(applied.synthesis.decision_ids, ["D-0001"]);
		assert.deepEqual(applied.synthesis.sections_changed, [{ heading: "Problem", operation: "append" }]);
		const source = await readFile(applied.spec.path, "utf8");
		assert.equal(readLevelTwoSection(source, "Initial Idea"), beforeIdea);
		assert.match(readLevelTwoSection(source, "Problem"), /OAuth sign-in is currently unavailable/u);
		await assert.rejects(
			createBaselineApprovalPlan(context.identity, context.workflowId, {
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: applied.spec.digest,
			}),
			(error) => error instanceof BaselineError && /latest synthesis ticket/u.test(error.message),
		);
		const plan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: applied.spec.digest,
			sourceSynthesisTicket: "T-0003",
			clock: CLOCK_2,
		});
		assert.equal(plan.baseline.source_synthesis_ticket, "T-0003");
	});
});

test("decision allocation is monotonic and supersession updates both reciprocal artifacts", async () => {
	await withWorkflow(async (context) => {
		let workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const first = await createDecision(context.identity, context.workflowId, DECISION_INPUT, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			clock: CLOCK_1,
		});
		assert.equal(first.decision.id, "D-0001");
		const firstSource = await readFile(first.decision.path, "utf8");
		await writeFile(
			first.decision.path,
			patchFrontmatter(firstSource, [{ path: ["future_extension"], value: { retained: true } }]),
		);
		const refreshedFirst = await inspectDecision(context.identity, context.workflowId, "D-0001", {
			homeDirectory: context.homeDirectory,
		});
		workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const successor = await supersedeDecision(
			context.identity,
			context.workflowId,
			"D-0001",
			{ ...DECISION_INPUT, title: "Require authorization code with PKCE" },
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				expectedDecisionDigest: refreshedFirst.digest,
				clock: CLOCK_2,
			},
		);
		assert.equal(successor.decision.id, "D-0002");
		assert.equal(successor.decision.supersedes, "D-0001");
		assert.equal(successor.superseded.status, "superseded");
		assert.equal(successor.superseded.superseded_by, "D-0002");
		assert.deepEqual(successor.superseded.metadata.future_extension, { retained: true });
		assert.match(
			readLevelTwoSection(await readFile(successor.superseded.path, "utf8"), "Supersession"),
			/Superseded by D-0002/u,
		);
		assert.equal(successor.workflow.metadata.next_decision_number, 3);
		assert.deepEqual((await listDecisions(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		})).map(({ id }) => id), ["D-0001", "D-0002"]);
	});
});

test("competing decision allocations serialize and never reuse the consumed ID", async () => {
	await withWorkflow(async (context) => {
		const workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const options = {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			clock: CLOCK_1,
		};
		const results = await Promise.allSettled([
			createDecision(context.identity, context.workflowId, DECISION_INPUT, options),
			createDecision(
				context.identity,
				context.workflowId,
				{ ...DECISION_INPUT, title: "Alternative concurrent decision" },
				options,
			),
		]);
		assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
		assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
		assert.ok(results.find(({ status }) => status === "rejected").reason instanceof RevisionConflictError);
		const currentWorkflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const second = await createDecision(
			context.identity,
			context.workflowId,
			{ ...DECISION_INPUT, title: "Second durable decision" },
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: currentWorkflow.digest,
				clock: CLOCK_2,
			},
		);
		assert.equal(second.decision.id, "D-0002");
	});
});

test("baseline approval rejects blockers and requires authorization tied to the reviewed snapshot", async () => {
	await withWorkflow(async (context) => {
		let workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		let spec = await inspectSpec(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		spec = (await setSpecOpenBlockers(context.identity, context.workflowId, ["T-0001"], {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_1,
		})).spec;
		await assert.rejects(
			createBaselineApprovalPlan(context.identity, context.workflowId, {
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
			}),
			(error) => error instanceof BaselineError && /open blockers/u.test(error.message),
		);
		spec = (await setSpecOpenBlockers(context.identity, context.workflowId, [], {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_2,
		})).spec;
		const plan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_2,
		});
		await assert.rejects(
			applyBaselineApprovalPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
			}),
			ConfirmationRequiredError,
		);
		await assert.rejects(readFile(plan.baseline.path, "utf8"), { code: "ENOENT" });
		const applied = await applyBaselineApprovalPlan(plan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(plan),
		});
		assert.equal(applied.baseline.id, "B-0001");
		assert.equal(applied.spec.metadata.status, "baselined");
		assert.equal(applied.spec.metadata.current_baseline, "B-0001");
		assert.equal(applied.workflow.phase, "planning");
		assert.equal(applied.workflow.metadata.current_baseline, "B-0001");
		assert.equal(applied.workflow.metadata.next_baseline_number, 2);
		assert.equal(parseBaselineArtifact(await readFile(applied.baseline.path, "utf8")).data.approved_by, "user");
	});
});

test("baseline revision preserves old snapshots, marks affected artifacts stale, and creates a new immutable snapshot", async () => {
	await withWorkflow(async (context) => {
		let workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		let spec = await inspectSpec(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const firstPlan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_1,
		});
		const first = await applyBaselineApprovalPlan(firstPlan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(firstPlan),
		});
		const firstBytes = await readFile(first.baseline.path);
		const revision = await beginBaselineRevision(context.identity, context.workflowId, {
			status: "suspended",
			rationale: "New provider constraints change the acceptance criteria.",
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: first.workflow.digest,
			expectedSpecDigest: first.spec.digest,
			clock: CLOCK_2,
		});
		assert.equal(revision.workflow.phase, "discovery");
		assert.equal(revision.spec.metadata.status, "suspended");
		assert.equal(revision.spec.metadata.based_on, "B-0001");
		const staleness = deriveBaselineStalenessData(revision.spec.metadata, [
			{ id: "T-0004", spec_baseline: "B-0001" },
			{ id: "T-0005", spec_baseline: null },
		]);
		assert.deepEqual(staleness.affected_artifact_ids, ["T-0004"]);
		assert.deepEqual(staleness.artifacts[0].reasons, ["baseline_suspended"]);
		spec = (await updateSpecDraftSections(
			context.identity,
			context.workflowId,
			[{ operation: "append", heading: "Acceptance Criteria", content: "Support the selected provider." }],
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: revision.workflow.digest,
				expectedSpecDigest: revision.spec.digest,
				clock: CLOCK_3,
			},
		)).spec;
		workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		const secondPlan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_3,
		});
		const second = await applyBaselineApprovalPlan(secondPlan, {
			identity: context.identity,
			homeDirectory: context.homeDirectory,
			authorization: authorization(secondPlan),
		});
		assert.equal(second.baseline.id, "B-0002");
		assert.deepEqual(await readFile(first.baseline.path), firstBytes);
		assert.deepEqual((await listBaselines(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		})).map(({ id }) => id), ["B-0001", "B-0002"]);
		const postApproval = deriveBaselineStalenessData(second.spec.metadata, [
			{ id: "T-0004", spec_baseline: "B-0001" },
		]);
		assert.deepEqual(postApproval.artifacts[0].reasons, ["baseline_mismatch"]);

		const tampered = `${await readFile(second.baseline.path, "utf8")}manual body edit\n`;
		await writeFile(second.baseline.path, tampered);
		await assert.rejects(
			inspectBaseline(context.identity, context.workflowId, "B-0002", {
				homeDirectory: context.homeDirectory,
			}),
			(error) => error instanceof BaselineError && error.code === "baseline_immutability_violation",
		);
	});
});

test("stale baseline plans cannot apply and discovery cannot bypass baseline approval", async () => {
	await withWorkflow(async (context) => {
		const workflow = await inspectWorkflow(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		let spec = await inspectSpec(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
		});
		await assert.rejects(
			transitionWorkflowPhase(context.identity, context.workflowId, "planning", {
				homeDirectory: context.homeDirectory,
				expectedDigest: workflow.digest,
			}),
			(error) => error instanceof WorkflowError && /baseline approval/u.test(error.message),
		);
		const plan = await createBaselineApprovalPlan(context.identity, context.workflowId, {
			homeDirectory: context.homeDirectory,
			expectedWorkflowDigest: workflow.digest,
			expectedSpecDigest: spec.digest,
			clock: CLOCK_1,
		});
		spec = (await updateSpecDraftSections(
			context.identity,
			context.workflowId,
			[{ operation: "append", heading: "Scope", content: "Implement OAuth sign-in." }],
			{
				homeDirectory: context.homeDirectory,
				expectedWorkflowDigest: workflow.digest,
				expectedSpecDigest: spec.digest,
				clock: CLOCK_2,
			},
		)).spec;
		assert.ok(spec.digest);
		await assert.rejects(
			applyBaselineApprovalPlan(plan, {
				identity: context.identity,
				homeDirectory: context.homeDirectory,
				authorization: authorization(plan),
			}),
			PlanMismatchError,
		);
	});
});
