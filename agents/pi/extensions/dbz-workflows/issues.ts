import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveWorkflowArtifactContext } from "../../../../skills/dbz-workflows/lib/artifacts.mjs";
import { ValidationError } from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import {
	applyIssueClosurePlan,
	applyIssueLinkPlan,
	createIssueClosurePlan,
	createIssueLinkPlan,
	DEVIATION_RESOLUTION_EFFECTS,
	evaluateIssueClosureEligibility,
	inspectLinkedIssue,
} from "../../../../skills/dbz-workflows/lib/issues-adapter.mjs";
import {
	assertCoordinatorMutation,
	mutationDescription,
	mutationGuidelines,
	projectIdentity,
	runQueuedMutation,
	toolResult,
	type FileMutationQueue,
} from "./tools.ts";
import { assertDialogUI, boundedText } from "./ui.ts";

export interface IssuesDependencies {
	inspectGitProject: typeof inspectGitProject;
	resolveWorkflowArtifactContext: typeof resolveWorkflowArtifactContext;
	inspectLinkedIssue: typeof inspectLinkedIssue;
	createIssueLinkPlan: typeof createIssueLinkPlan;
	applyIssueLinkPlan: typeof applyIssueLinkPlan;
	evaluateIssueClosureEligibility: typeof evaluateIssueClosureEligibility;
	createIssueClosurePlan: typeof createIssueClosurePlan;
	applyIssueClosurePlan: typeof applyIssueClosurePlan;
}

const DEFAULT_DEPENDENCIES: IssuesDependencies = {
	inspectGitProject,
	resolveWorkflowArtifactContext,
	inspectLinkedIssue,
	createIssueLinkPlan,
	applyIssueLinkPlan,
	evaluateIssueClosureEligibility,
	createIssueClosurePlan,
	applyIssueClosurePlan,
};

const DeviationDeterminationInput = Type.Object({
	verification_digest: Type.String(),
	effects: Type.Array(Type.Object({
		deviation_id: Type.String(),
		effect: StringEnum([...DEVIATION_RESOLUTION_EFFECTS] as [
			"does_not_invalidate_resolution",
			"invalidates_resolution",
		]),
		rationale: Type.String(),
	}), { minItems: 1 }),
});

function deviationDetermination(issueId: string, input: any): any {
	return input === undefined
		? undefined
		: { issue_id: issueId, ...input };
}

function formatLinkPlan(plan: any): string {
	return boundedText([
		`Workflow: ${plan.workflow.id}`,
		`Issue: ${plan.issue.id}`,
		`Relation: ${plan.relation}`,
		`Action: ${plan.action}`,
		"",
		"Bidirectional changes:",
		...(plan.changes.length === 0
			? ["- No changes; both sides already contain the reviewed relation."]
			: plan.changes.map((change: any) => `- ${change.action}: ${change.path}`)),
		"",
		"The issue remains open. Workflow completion never closes it without a separate explicit confirmation.",
	].join("\n"));
}

function formatClosurePlan(plan: any): string {
	const review = plan.deviation_review;
	const hasDeviations = review?.deviations?.length > 0;
	const deviationLines = hasDeviations
		? review.deviations.map((deviation: any) =>
			`- ${deviation.id} (${deviation.blocking ? "blocking" : "non-blocking"}): ${deviation.description}`,
		)
		: ["- No deviations were recorded in the exact reviewed verification evidence."];
	const determinationLines = review?.determination?.effects?.length > 0
		? review.determination.effects.map((effect: any) =>
			`- ${effect.deviation_id}: ${effect.effect} — ${effect.rationale}`,
		)
		: [hasDeviations
			? "- Missing determination; this closure plan is invalid and must not be applied."
			: "- No determination is required because no deviations were recorded."];
	const message = [
		`Issue: ${plan.issue.id}`,
		`Workflow: ${plan.workflow.id} (${plan.workflow.phase})`,
		`Relation: ${plan.relation}`,
		`Verified commit: ${plan.verification.verified_commit ?? "no project changes"}`,
		`Verification digest: ${plan.verification.digest}`,
		`Deviation evidence digest: ${review?.evidence_sha256 ?? "unavailable"}`,
		`Deviation review status: ${review?.status ?? "unavailable"}`,
		"",
		"Recorded deviation evidence:",
		...deviationLines,
		"",
		`Determination for resolves link to ${plan.issue.id}:`,
		...determinationLines,
		"",
		"This terminal DBZ Issues close operation cannot be undone in V1. Closure is never inferred from workflow completion and requires this exact confirmation.",
	].join("\n");
	const bounded = boundedText(message);
	if (bounded !== message) {
		throw new ValidationError("Issue closure confirmation cannot display all deviation evidence within Pi's output limit; reduce or split the evidence before retrying.");
	}
	return bounded;
}

export function registerIssuesTools(
	pi: ExtensionAPI,
	{
		dependencies,
		homeDirectory = homedir(),
		fileMutationQueue = withFileMutationQueue,
	}: {
		dependencies?: Partial<IssuesDependencies>;
		homeDirectory?: string;
		fileMutationQueue?: FileMutationQueue;
	} = {},
): void {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as IssuesDependencies;

	pi.registerTool({
		name: "dbz_workflows_inspect_issue",
		label: "Inspect DBZ Workflow Issue",
		description: "Inspect one local DBZ issue and its workflow links through the supported DBZ Issues CLI adapter without editing registry files directly.",
		promptSnippet: "Inspect one local DBZ issue and its DBZ Workflows links",
		parameters: Type.Object({ issue_id: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			return toolResult("inspect_issue", await deps.inspectLinkedIssue(identity, params.issue_id));
		},
	});

	pi.registerTool({
		name: "dbz_workflows_link_issue",
		label: "Link DBZ Workflow Issue",
		description: mutationDescription(
			"dbz_workflows_link_issue",
			"uses the supported DBZ Issues adapter to record a confirmed bidirectional workflow relation while leaving the issue open",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_link_issue"),
		executionMode: "sequential",
		parameters: Type.Object({
			workflow_id: Type.String(),
			issue_id: Type.String(),
			relation: StringEnum(["resolves", "partially-addresses", "related"] as const),
			expected_workflow_digest: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_link_issue");
			assertDialogUI(ctx, "DBZ Workflows issue linking");
			const identity = await projectIdentity(ctx, deps);
			const plan = await deps.createIssueLinkPlan(identity, params.workflow_id, params.issue_id, params.relation, {
				expectedWorkflowDigest: params.expected_workflow_digest,
				homeDirectory,
			});
			const confirmed = await ctx.ui.confirm("Link DBZ issue and workflow?", formatLinkPlan(plan));
			if (!confirmed) throw new ValidationError("Issue linking was not confirmed and neither canonical side was changed.");
			return runQueuedMutation(
				[plan.workflow.path, plan.issue.path],
				async () => toolResult("link_issue", await deps.applyIssueLinkPlan(plan, {
					identity,
					homeDirectory,
					authorization: { confirmed: true, planDigest: plan.plan_digest },
				})),
				fileMutationQueue,
			);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_issue_closure_eligibility",
		label: "Check DBZ Issue Closure Eligibility",
		description: "Derive local DBZ issue closure eligibility from the bidirectional relation, workflow completion, current verification, issue-specific deviation determinations, final integration, and target containment. Recorded deviations remain ineligible until every effect on this resolves link is explicitly established. This never closes an issue.",
		promptSnippet: "Check whether a resolves-linked local DBZ issue is eligible for explicit closure",
		parameters: Type.Object({
			workflow_id: Type.String(),
			issue_id: Type.String(),
			deviation_determination: Type.Optional(DeviationDeterminationInput),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			return toolResult("issue_closure_eligibility", await deps.evaluateIssueClosureEligibility(
				identity,
				params.workflow_id,
				params.issue_id,
				{
					homeDirectory,
					deviationDetermination: deviationDetermination(params.issue_id, params.deviation_determination),
				},
			));
		},
	});

	pi.registerTool({
		name: "dbz_workflows_close_issue",
		label: "Close DBZ Workflow Issue",
		description: mutationDescription(
			"dbz_workflows_close_issue",
			"uses the DBZ Issues terminal close interface only for an eligible resolves link and only after explicit human confirmation",
		),
		promptGuidelines: [
			...mutationGuidelines("dbz_workflows_close_issue"),
			"Use dbz_workflows_close_issue with an exact per-deviation determination from dbz_workflows_issue_closure_eligibility whenever the current verification recorded deviations; never infer that a passed verification is deviation-safe.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			workflow_id: Type.String(),
			issue_id: Type.String(),
			deviation_determination: Type.Optional(DeviationDeterminationInput),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_close_issue");
			assertDialogUI(ctx, "DBZ Issues closure");
			const identity = await projectIdentity(ctx, deps);
			const plan = await deps.createIssueClosurePlan(identity, params.workflow_id, params.issue_id, {
				homeDirectory,
				deviationDetermination: deviationDetermination(params.issue_id, params.deviation_determination),
			});
			const confirmed = await ctx.ui.confirm(`Close issue ${params.issue_id}?`, formatClosurePlan(plan));
			if (!confirmed) throw new ValidationError("Issue closure was not explicitly confirmed and the issue remains open.");
			return runQueuedMutation(
				[plan.issue.path],
				async () => toolResult("close_issue", await deps.applyIssueClosurePlan(plan, {
					identity,
					homeDirectory,
					authorization: { confirmed: true, planDigest: plan.plan_digest },
				})),
				fileMutationQueue,
			);
		},
	});
}
