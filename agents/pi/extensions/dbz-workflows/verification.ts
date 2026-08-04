import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveWorkflowArtifactContext } from "../../../../skills/dbz-workflows/lib/artifacts.mjs";
import { ERROR_CODES, ValidationError } from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import {
	applyWorkflowFinalIntegrationPlan,
	completeWorkflowAfterIntegration,
	createWorkflowFinalIntegrationPlan,
	inspectVerification,
	recordVerificationOutcome,
	startVerification,
} from "../../../../skills/dbz-workflows/lib/verification.mjs";
import { inspectWorkflow } from "../../../../skills/dbz-workflows/lib/workflows.mjs";
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

export interface VerificationDependencies {
	inspectGitProject: typeof inspectGitProject;
	resolveWorkflowArtifactContext: typeof resolveWorkflowArtifactContext;
	inspectWorkflow: typeof inspectWorkflow;
	inspectVerification: typeof inspectVerification;
	startVerification: typeof startVerification;
	recordVerificationOutcome: typeof recordVerificationOutcome;
	createWorkflowFinalIntegrationPlan: typeof createWorkflowFinalIntegrationPlan;
	applyWorkflowFinalIntegrationPlan: typeof applyWorkflowFinalIntegrationPlan;
	completeWorkflowAfterIntegration: typeof completeWorkflowAfterIntegration;
}

const DEFAULT_DEPENDENCIES: VerificationDependencies = {
	inspectGitProject,
	resolveWorkflowArtifactContext,
	inspectWorkflow,
	inspectVerification,
	startVerification,
	recordVerificationOutcome,
	createWorkflowFinalIntegrationPlan,
	applyWorkflowFinalIntegrationPlan,
	completeWorkflowAfterIntegration,
};

function verificationSummary(verification: any): string {
	return boundedText([
		`Verification outcome: ${verification.outcome}`,
		`Baseline: ${verification.baseline}`,
		`Verified commit: ${verification.verified_commit ?? "no project changes"}`,
		`Stale: ${verification.stale ? "yes" : "no"}`,
		`Integration: ${verification.metadata.integration.status}`,
		`Recorded deviations: ${verification.deviations?.length ?? "unavailable"}`,
		...(verification.stale
			? verification.staleness.reasons.map((reason: any) => `- ${reason.code}`)
			: []),
	].join("\n"));
}

function formatFinalIntegrationPlan(plan: any): string {
	return boundedText([
		`Verified commit: ${plan.verification.verified_commit}`,
		`Workflow branch: ${plan.git_plan.workflow.branch}`,
		`Target branch: ${plan.git_plan.target.branch}`,
		`Target commit before apply: ${plan.git_plan.target.commit}`,
		`Action: ${plan.git_plan.action}`,
		...(plan.git_plan.source?.allowed_dirty
			? [`Pending canonical project-storage entries retained: ${plan.git_plan.source.allowed_dirty.entry_count} under ${plan.git_plan.source.allowed_dirty.root}`]
			: []),
		"",
		"Planned changes:",
		...(plan.changes.length === 0
			? ["- Target already contains the exact verified commit; confirmation records that external integration."]
			: plan.changes.map((change: any) => `- ${change.action}: ${change.branch} ${change.from} -> ${change.to}`)),
	].join("\n"));
}

function parseCommandLines(value: string | undefined): string[] {
	return (value ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function runVerificationCommand(
	ctx: ExtensionCommandContext,
	identity: any,
	workflow: any,
	{
		homeDirectory = homedir(),
		dependencies,
	}: {
		homeDirectory?: string;
		dependencies?: Partial<VerificationDependencies>;
	} = {},
): Promise<void> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as VerificationDependencies;
	if (["completed", "cancelled"].includes(workflow.phase)) {
		let verification: any = null;
		try {
			verification = await deps.inspectVerification(identity, workflow.id, { homeDirectory });
		} catch {}
		ctx.ui.notify(
			verification === null
				? `Workflow '${workflow.id}' is ${workflow.phase} and has no available verification summary.`
				: verificationSummary(verification),
			"info",
		);
		return;
	}
	let verification: any = null;
	try {
		verification = await deps.inspectVerification(identity, workflow.id, { homeDirectory });
	} catch (error: any) {
		if (error?.code !== ERROR_CODES.VERIFICATION_NOT_FOUND) throw error;
	}
	if (workflow.phase === "execution") {
		const confirmed = await ctx.ui.confirm(
			`Start verification for ${workflow.id}?`,
			[
				`Baseline: ${workflow.current_baseline ?? "none"}`,
				`Existing attempt: ${verification?.metadata.attempt ?? "none"}`,
				"The core will require all mandatory pre-verification delivery tickets to be completed and integrated, create or reset verification.md, and move the workflow to verification.",
			].join("\n"),
		);
		if (!confirmed) {
			ctx.ui.notify("Verification start was not confirmed.", "info");
			return;
		}
		const result = await deps.startVerification(identity, workflow.id, {
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification?.digest ?? null,
			homeDirectory,
		});
		ctx.ui.notify(verificationSummary(result.verification), "info");
		return;
	}
	if (workflow.phase !== "verification") {
		throw new ValidationError(`Workflow '${workflow.id}' is in phase '${workflow.phase}', not execution or verification.`);
	}
	if (verification === null) {
		throw new ValidationError("The verification phase is missing verification.md; return to execution and start a guarded verification attempt.");
	}
	ctx.ui.notify(verificationSummary(verification), verification.stale ? "warning" : "info");
	if (verification.stale || verification.outcome === "blocked") {
		const confirmed = await ctx.ui.confirm(
			`Restart verification attempt ${verification.metadata.attempt + 1}?`,
			"This replaces the current editable verification attempt with pending evidence tied to the current baseline and workflow commit. Existing Git changes are not modified.",
		);
		if (!confirmed) return;
		const result = await deps.startVerification(identity, workflow.id, {
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory,
		});
		ctx.ui.notify(verificationSummary(result.verification), "info");
		return;
	}
	if (verification.outcome === "pending") {
		ctx.ui.notify(
			"Complete and accept the exclusive verification ticket, then use dbz_workflows_record_verification to record criterion-by-criterion evidence. Opening this status does not dispatch work.",
			"info",
		);
		return;
	}
	if (verification.outcome !== "passed") {
		ctx.ui.notify("Failed verification has returned to execution through its explicit correction tickets.", "warning");
		return;
	}
	if (verification.metadata.integration.status === "awaiting") {
		const targetBranch = (await ctx.ui.input(
			"Final integration target branch",
			workflow.metadata.git.base_branch ?? "main",
		))?.trim();
		if (!targetBranch) return;
		const plan = await deps.createWorkflowFinalIntegrationPlan(identity, workflow.id, {
			targetBranch,
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory,
		});
		const confirmed = await ctx.ui.confirm("Apply final workflow integration?", formatFinalIntegrationPlan(plan));
		if (!confirmed) {
			ctx.ui.notify("Final integration was not confirmed; the workflow remains awaiting integration.", "info");
			return;
		}
		const applied = await deps.applyWorkflowFinalIntegrationPlan(plan, {
			identity,
			homeDirectory,
			authorization: { confirmed: true, planDigest: plan.plan_digest },
		});
		ctx.ui.notify(
			`Target '${applied.git.target_branch}' now contains '${applied.git.workflow_commit}'. Run required post-integration validation against exact target commit '${applied.git.target_commit}', then invoke /dbz-workflows verify again to record it.`,
			"warning",
		);
		return;
	}
	if (verification.metadata.integration.status === "integrated") {
		const integration = verification.metadata.integration;
		const commandText = await ctx.ui.editor(
			"Post-integration validation commands (one per line)",
			"npm test",
		);
		const commands = parseCommandLines(commandText);
		if (commands.length === 0) return;
		const evidence = (await ctx.ui.input(
			"Post-integration validation evidence",
			"All required checks passed against the exact target commit.",
		))?.trim();
		if (!evidence) return;
		const confirmed = await ctx.ui.confirm(
			`Complete ${workflow.id}?`,
			[
				`Target branch: ${integration.target_branch}`,
				`Validated commit: ${integration.target_commit}`,
				"Commands:",
				...commands.map((command) => `- ${command}`),
				`Evidence: ${evidence}`,
				"Completion will revalidate target containment and the exact target commit before changing canonical workflow state.",
			].join("\n"),
		);
		if (!confirmed) return;
		const completed = await deps.completeWorkflowAfterIntegration(identity, workflow.id, {
			passed: true,
			commands,
			evidence,
			validated_commit: integration.target_commit,
		}, {
			expectedWorkflowDigest: workflow.digest,
			expectedVerificationDigest: verification.digest,
			homeDirectory,
		});
		ctx.ui.notify(`Workflow '${workflow.id}' completed at target commit '${completed.target_commit}'.`, "info");
	}
}

async function contextPaths(
	ctx: ExtensionContext,
	workflowId: string,
	deps: VerificationDependencies,
	homeDirectory: string,
) {
	const identity = await projectIdentity(ctx, deps);
	const context = await deps.resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return { identity, context };
}

export function registerVerificationTools(
	pi: ExtensionAPI,
	{
		dependencies,
		homeDirectory = homedir(),
		fileMutationQueue = withFileMutationQueue,
	}: {
		dependencies?: Partial<VerificationDependencies>;
		homeDirectory?: string;
		fileMutationQueue?: FileMutationQueue;
	} = {},
): void {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as VerificationDependencies;

	pi.registerTool({
		name: "dbz_workflows_inspect_verification",
		label: "Inspect DBZ Workflows Verification",
		description: "Inspect canonical verification metadata, outcome, exact commit, integration status, recorded deviation evidence, and derived staleness without returning the full artifact body.",
		promptSnippet: "Inspect DBZ Workflows verification outcome and derived staleness",
		parameters: Type.Object({ workflow_id: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			return toolResult("inspect_verification", await deps.inspectVerification(identity, params.workflow_id, { homeDirectory }));
		},
	});

	pi.registerTool({
		name: "dbz_workflows_start_verification",
		label: "Start DBZ Workflows Verification",
		description: mutationDescription(
			"dbz_workflows_start_verification",
			"creates or resets verification.md and enters verification only after mandatory delivery and integration gates pass",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_start_verification"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			expected_workflow_digest: Type.String(),
			expected_verification_digest: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_start_verification");
			const selected = await contextPaths(ctx, params.workflow_id, deps, homeDirectory);
			return runQueuedMutation(
				[selected.context.workflow.path, selected.context.paths.verification],
				async () => toolResult("start_verification", await deps.startVerification(selected.identity, params.workflow_id, {
					expectedWorkflowDigest: params.expected_workflow_digest,
					expectedVerificationDigest: params.expected_verification_digest ?? null,
					homeDirectory,
				})),
				fileMutationQueue,
			);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_record_verification",
		label: "Record DBZ Workflows Verification",
		description: mutationDescription(
			"dbz_workflows_record_verification",
			"records criterion and mandatory-ticket evidence, outcomes, correction tickets, and the next guarded lifecycle state",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_record_verification"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			expected_workflow_digest: Type.String(),
			expected_verification_digest: Type.String(),
			outcome: StringEnum(["passed", "failed", "blocked"] as const),
			criterion_evidence: Type.Array(Type.Object({
				id: Type.String(),
				outcome: StringEnum(["passed", "failed", "blocked"] as const),
				evidence: Type.String(),
			})),
			mandatory_ticket_evidence: Type.Array(Type.Object({
				ticket_id: Type.String(),
				evidence: Type.String(),
			})),
			deviations: Type.Optional(Type.Array(Type.Object({
				description: Type.String(),
				blocking: Type.Boolean(),
			}))),
			correction_ticket_ids: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_record_verification");
			const selected = await contextPaths(ctx, params.workflow_id, deps, homeDirectory);
			return runQueuedMutation(
				[selected.context.workflow.path, selected.context.paths.verification],
				async () => toolResult("record_verification", await deps.recordVerificationOutcome(selected.identity, params.workflow_id, {
					outcome: params.outcome,
					criterionEvidence: params.criterion_evidence,
					mandatoryTicketEvidence: params.mandatory_ticket_evidence,
					deviations: params.deviations ?? [],
					correctionTicketIds: params.correction_ticket_ids,
					expectedWorkflowDigest: params.expected_workflow_digest,
					expectedVerificationDigest: params.expected_verification_digest,
					homeDirectory,
				})),
				fileMutationQueue,
			);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_integrate_workflow",
		label: "Integrate DBZ Workflow",
		description: mutationDescription(
			"dbz_workflows_integrate_workflow",
			"creates and displays an exact final Git plan, requires interactive confirmation, validates the verified commit, and records target containment",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_integrate_workflow"),
		executionMode: "sequential",
		parameters: Type.Object({
			workflow_id: Type.String(),
			target_branch: Type.String(),
			expected_workflow_digest: Type.String(),
			expected_verification_digest: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_integrate_workflow");
			assertDialogUI(ctx, "DBZ Workflows final integration");
			const selected = await contextPaths(ctx, params.workflow_id, deps, homeDirectory);
			const plan = await deps.createWorkflowFinalIntegrationPlan(selected.identity, params.workflow_id, {
				targetBranch: params.target_branch,
				expectedWorkflowDigest: params.expected_workflow_digest,
				expectedVerificationDigest: params.expected_verification_digest,
				homeDirectory,
			});
			const confirmed = await ctx.ui.confirm("Apply final workflow integration?", formatFinalIntegrationPlan(plan));
			if (!confirmed) throw new ValidationError("Final integration was not confirmed and no Git or canonical state was changed.");
			return runQueuedMutation(
				[selected.context.paths.verification],
				async () => toolResult("integrate_workflow", await deps.applyWorkflowFinalIntegrationPlan(plan, {
					identity: selected.identity,
					homeDirectory,
					authorization: { confirmed: true, planDigest: plan.plan_digest },
				})),
				fileMutationQueue,
			);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_complete_workflow",
		label: "Complete DBZ Workflow",
		description: mutationDescription(
			"dbz_workflows_complete_workflow",
			"records required post-integration validation and completes only after exact target-branch containment is revalidated",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_complete_workflow"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			expected_workflow_digest: Type.String(),
			expected_verification_digest: Type.String(),
			validated_commit: Type.String(),
			commands: Type.Array(Type.String(), { minItems: 1 }),
			evidence: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_complete_workflow");
			const selected = await contextPaths(ctx, params.workflow_id, deps, homeDirectory);
			return runQueuedMutation(
				[selected.context.workflow.path, selected.context.paths.verification],
				async () => toolResult("complete_workflow", await deps.completeWorkflowAfterIntegration(selected.identity, params.workflow_id, {
					passed: true,
					validated_commit: params.validated_commit,
					commands: params.commands,
					evidence: params.evidence,
				}, {
					expectedWorkflowDigest: params.expected_workflow_digest,
					expectedVerificationDigest: params.expected_verification_digest,
					homeDirectory,
				})),
				fileMutationQueue,
			);
		},
	});
}
