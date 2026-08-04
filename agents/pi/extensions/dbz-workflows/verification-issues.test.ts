import assert from "node:assert/strict";
import test from "node:test";
import { registerIssuesTools } from "./issues.ts";
import { registerVerificationTools } from "./verification.ts";

function harness() {
	const tools = new Map<string, any>();
	return {
		tools,
		pi: {
			registerTool(definition: any) {
				tools.set(definition.name, definition);
			},
		},
	};
}

const identity = {
	projectRoot: "/project",
	projectKey: `git-sha1-${"a".repeat(40)}`,
	objectFormat: "sha1",
	rootCommit: "a".repeat(40),
};

function context(confirmValues: boolean[] = [false]) {
	const confirms: Array<{ title: string; message: string }> = [];
	return {
		confirms,
		ctx: {
			cwd: "/project",
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => "coordinator",
				getBranch: () => [],
			},
			ui: {
				async confirm(title: string, message: string) {
					confirms.push({ title, message });
					return confirmValues.shift() ?? false;
				},
			},
		},
	};
}

const artifactContext = {
	workflow: {
		id: "WF-0001",
		path: "/storage/WF-0001-example/workflow.md",
	},
	paths: {
		verification: "/storage/WF-0001-example/verification.md",
	},
};

test("verification final integration never applies without exact interactive confirmation", async () => {
	const first = harness();
	let applied = false;
	const plan = {
		plan_digest: "f".repeat(64),
		verification: { verified_commit: "a".repeat(40) },
		git_plan: {
			workflow: { branch: "dbz-workflows/WF-0001-example" },
			target: { branch: "main", commit: "b".repeat(40) },
			action: "fast_forward_target_ref",
		},
		changes: [{ action: "fast_forward_ref", branch: "main", from: "b".repeat(40), to: "a".repeat(40) }],
	};
	registerVerificationTools(first.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveWorkflowArtifactContext: async () => artifactContext as any,
			createWorkflowFinalIntegrationPlan: async () => plan as any,
			applyWorkflowFinalIntegrationPlan: async () => {
				applied = true;
				return { changed: true } as any;
			},
		},
	});
	const declined = context([false]);
	await assert.rejects(
		first.tools.get("dbz_workflows_integrate_workflow").execute(
			"call-1",
			{
				workflow_id: "WF-0001",
				target_branch: "main",
				expected_workflow_digest: "1".repeat(64),
				expected_verification_digest: "2".repeat(64),
			},
			undefined,
			undefined,
			declined.ctx,
		),
		/not confirmed/u,
	);
	assert.equal(applied, false);
	assert.match(declined.confirms[0].message, /Verified commit/u);

	const queued: string[] = [];
	const second = harness();
	let authorization: any;
	registerVerificationTools(second.pi as any, {
		fileMutationQueue: (async (path: string, callback: () => Promise<any>) => {
			queued.push(path);
			return callback();
		}) as any,
		dependencies: {
			inspectGitProject: async () => identity as any,
			resolveWorkflowArtifactContext: async () => artifactContext as any,
			createWorkflowFinalIntegrationPlan: async () => plan as any,
			applyWorkflowFinalIntegrationPlan: async (_plan, options) => {
				authorization = options.authorization;
				return { changed: true } as any;
			},
		},
	});
	const confirmed = context([true]);
	await second.tools.get("dbz_workflows_integrate_workflow").execute(
		"call-2",
		{
			workflow_id: "WF-0001",
			target_branch: "main",
			expected_workflow_digest: "1".repeat(64),
			expected_verification_digest: "2".repeat(64),
		},
		undefined,
		undefined,
		confirmed.ctx,
	);
	assert.deepEqual(authorization, { confirmed: true, planDigest: plan.plan_digest });
	assert.deepEqual(queued, [artifactContext.paths.verification]);
});

test("DBZ issue closure is read-only when declined and uses only the confirmed adapter plan", async () => {
	const first = harness();
	let closed = false;
	const determination = {
		verification_digest: "d".repeat(64),
		effects: [{
			deviation_id: "DEV-001",
			effect: "does_not_invalidate_resolution",
			rationale: "The issue does not require the optional legacy report formatting.",
		}],
	};
	const plan = {
		plan_digest: "e".repeat(64),
		workflow: { id: "WF-0001", phase: "completed" },
		verification: { digest: determination.verification_digest, verified_commit: null },
		deviation_review: {
			status: "does_not_invalidate_resolution",
			evidence_sha256: "c".repeat(64),
			deviations: [{
				id: "DEV-001",
				blocking: false,
				description: "The optional legacy report retains its previous visual formatting.",
			}],
			determination: { issue_id: "001-example", ...determination },
		},
		issue: { id: "001-example", path: "/project/issues/open/001-example.md" },
		relation: "resolves",
	};
	registerIssuesTools(first.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			createIssueClosurePlan: async () => plan as any,
			applyIssueClosurePlan: async () => {
				closed = true;
				return { closed: true } as any;
			},
		},
	});
	const declined = context([false]);
	await assert.rejects(
		first.tools.get("dbz_workflows_close_issue").execute(
			"call-close",
			{
				workflow_id: "WF-0001",
				issue_id: "001-example",
				deviation_determination: determination,
			},
			undefined,
			undefined,
			declined.ctx,
		),
		/not explicitly confirmed/u,
	);
	assert.equal(closed, false);
	assert.match(declined.confirms[0].message, /non-blocking.*optional legacy report/u);
	assert.match(declined.confirms[0].message, /does_not_invalidate_resolution.*does not require/u);
	assert.match(declined.confirms[0].message, /cannot be undone/u);

	const second = harness();
	let authorization: any;
	let reviewedDetermination: any;
	registerIssuesTools(second.pi as any, {
		dependencies: {
			inspectGitProject: async () => identity as any,
			createIssueClosurePlan: async (_identity, _workflowId, _issueId, options) => {
				reviewedDetermination = options.deviationDetermination;
				return plan as any;
			},
			applyIssueClosurePlan: async (_plan, options) => {
				authorization = options.authorization;
				return { closed: true } as any;
			},
		},
	});
	await second.tools.get("dbz_workflows_close_issue").execute(
		"call-close-confirmed",
		{
			workflow_id: "WF-0001",
			issue_id: "001-example",
			deviation_determination: determination,
		},
		undefined,
		undefined,
		context([true]).ctx,
	);
	assert.deepEqual(reviewedDetermination, { issue_id: "001-example", ...determination });
	assert.deepEqual(authorization, { confirmed: true, planDigest: plan.plan_digest });
});

test("every S13 mutation tool names itself and prohibits direct managed-frontmatter edits", () => {
	const registered = harness();
	registerVerificationTools(registered.pi as any);
	registerIssuesTools(registered.pi as any);
	const mutating = [...registered.tools.values()].filter((tool) => tool.promptGuidelines !== undefined);
	assert.deepEqual(mutating.map(({ name }) => name), [
		"dbz_workflows_start_verification",
		"dbz_workflows_record_verification",
		"dbz_workflows_integrate_workflow",
		"dbz_workflows_complete_workflow",
		"dbz_workflows_link_issue",
		"dbz_workflows_close_issue",
	]);
	for (const tool of mutating) {
		assert.match(tool.description, new RegExp(tool.name, "u"));
		assert.match(tool.description, /frontmatter directly/u);
		assert.match(tool.promptGuidelines[0], new RegExp(tool.name, "u"));
	}
});
