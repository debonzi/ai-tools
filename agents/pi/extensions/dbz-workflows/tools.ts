import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveWorkflowArtifactContext } from "../../../../skills/dbz-workflows/lib/artifacts.mjs";
import { inspectBaseline } from "../../../../skills/dbz-workflows/lib/baselines.mjs";
import { recoverTicketClaim } from "../../../../skills/dbz-workflows/lib/claims.mjs";
import { validateTicketDag } from "../../../../skills/dbz-workflows/lib/dag.mjs";
import { inspectDecision } from "../../../../skills/dbz-workflows/lib/decisions.mjs";
import { RevisionConflictError, ValidationError } from "../../../../skills/dbz-workflows/lib/errors.mjs";
import { createExecutorResult } from "../../../../skills/dbz-workflows/lib/executors/protocol.mjs";
import { startManualExecution } from "../../../../skills/dbz-workflows/lib/executors/manual.mjs";
import { readFileWithDigest } from "../../../../skills/dbz-workflows/lib/filesystem.mjs";
import { readFrontmatter } from "../../../../skills/dbz-workflows/lib/frontmatter.mjs";
import { inspectGitProject } from "../../../../skills/dbz-workflows/lib/git-identity.mjs";
import { readLevelTwoSection } from "../../../../skills/dbz-workflows/lib/markdown.mjs";
import { acceptExecutorResult, applyExecutorResult } from "../../../../skills/dbz-workflows/lib/results.mjs";
import { planSchedulerWave } from "../../../../skills/dbz-workflows/lib/scheduler.mjs";
import { formatSequentialId } from "../../../../skills/dbz-workflows/lib/schemas/identifiers.mjs";
import { isProjectMutatingTicket } from "../../../../skills/dbz-workflows/lib/schemas/ticket.mjs";
import { inspectSpec, updateSpecDraftSections } from "../../../../skills/dbz-workflows/lib/specs.mjs";
import {
	createTicket,
	inspectTicket,
	listTickets,
	queryTicketReadiness,
	transitionTicketStatus,
} from "../../../../skills/dbz-workflows/lib/tickets.mjs";
import {
	generateImmutableSlug,
	inspectWorkflow,
	listWorkflows,
} from "../../../../skills/dbz-workflows/lib/workflows.mjs";
import {
	createCurrentSessionExecutorResult,
	prepareCoordinatorAcceptance,
	submittedResultResponse,
} from "./results.ts";
import {
	coordinatorCwdForSession,
	currentTicketSessionLocator,
} from "./sessions.ts";
import { assertDialogUI, assertTrustedProject } from "./ui.ts";

const ARTIFACT_KINDS = ["workflow", "spec", "ticket", "decision", "baseline"] as const;
const INSPECTION_ACTIONS = ["list_workflows", "workflow", "list_tickets", "ticket"] as const;

export type FileMutationQueue = typeof withFileMutationQueue;

export interface ToolDependencies {
	inspectGitProject: typeof inspectGitProject;
	resolveWorkflowArtifactContext: typeof resolveWorkflowArtifactContext;
	listWorkflows: typeof listWorkflows;
	inspectWorkflow: typeof inspectWorkflow;
	listTickets: typeof listTickets;
	inspectTicket: typeof inspectTicket;
	inspectSpec: typeof inspectSpec;
	inspectDecision: typeof inspectDecision;
	inspectBaseline: typeof inspectBaseline;
	readFileWithDigest: typeof readFileWithDigest;
	createTicket: typeof createTicket;
	transitionTicketStatus: typeof transitionTicketStatus;
	updateSpecDraftSections: typeof updateSpecDraftSections;
	queryTicketReadiness: typeof queryTicketReadiness;
	validateTicketDag: typeof validateTicketDag;
	startManualExecution: typeof startManualExecution;
	recoverTicketClaim: typeof recoverTicketClaim;
	applyExecutorResult: typeof applyExecutorResult;
	acceptExecutorResult: typeof acceptExecutorResult;
	planSchedulerWave: typeof planSchedulerWave;
	createExecutorResult: typeof createExecutorResult;
}

const DEFAULT_DEPENDENCIES: ToolDependencies = {
	inspectGitProject,
	resolveWorkflowArtifactContext,
	listWorkflows,
	inspectWorkflow,
	listTickets,
	inspectTicket,
	inspectSpec,
	inspectDecision,
	inspectBaseline,
	readFileWithDigest,
	createTicket,
	transitionTicketStatus,
	updateSpecDraftSections,
	queryTicketReadiness,
	validateTicketDag,
	startManualExecution,
	recoverTicketClaim,
	applyExecutorResult,
	acceptExecutorResult,
	planSchedulerWave,
	createExecutorResult,
};

interface ArtifactReference {
	kind: typeof ARTIFACT_KINDS[number];
	id: string;
	path: string;
	digest: string;
}

function requireValue(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ValidationError(`${name} is required.`);
	}
	return value.trim();
}

function rejectValue(value: unknown, name: string): void {
	if (value !== undefined) throw new ValidationError(`${name} is not valid for this action.`);
}

function mutationDescription(name: string, purpose: string): string {
	return `${name} ${purpose} through deterministic DBZ Workflows core operations. ` +
		`Use ${name} instead of editing DBZ Workflows managed frontmatter directly; direct managed-frontmatter edits are prohibited.`;
}

function mutationGuidelines(name: string): string[] {
	return [
		`Use ${name} only for its documented canonical mutation, and do not edit DBZ Workflows managed frontmatter directly.`,
	];
}

export function boundedToolText(value: unknown): { text: string; truncated: boolean } {
	const source = `${JSON.stringify(value, null, 2)}\n`;
	const reserveBytes = 256;
	const first = truncateHead(source, {
		maxBytes: DEFAULT_MAX_BYTES - reserveBytes,
		maxLines: DEFAULT_MAX_LINES - 2,
	});
	if (!first.truncated) return { text: first.content, truncated: false };
	const withNotice = `${first.content}\n[Output truncated to Pi's 50 KB / 2,000-line limit. Use a narrower DBZ Workflows query; canonical artifacts remain on disk.]\n`;
	return {
		text: truncateHead(withNotice, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		}).content,
		truncated: true,
	};
}

function toolResult(operation: string, value: unknown) {
	const bounded = boundedToolText(value);
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: { operation, truncated: bounded.truncated },
	};
}

export async function runQueuedMutation<T>(
	paths: string[],
	callback: () => Promise<T>,
	queue: FileMutationQueue = withFileMutationQueue,
): Promise<T> {
	if (!Array.isArray(paths) || paths.length === 0) {
		throw new ValidationError("A queued DBZ Workflows mutation requires at least one target path.");
	}
	const targets = [...new Set(paths.map((path) => resolve(requireValue(path, "mutation target path"))))].sort();
	let run = callback;
	for (const target of [...targets].reverse()) {
		const next = run;
		run = () => queue(target, next);
	}
	return run();
}

async function projectIdentity(ctx: ExtensionContext, deps: ToolDependencies): Promise<any> {
	assertTrustedProject(ctx);
	const locator = currentTicketSessionLocator(ctx.sessionManager);
	const identity = await deps.inspectGitProject(coordinatorCwdForSession(ctx));
	if (locator !== null && identity.projectKey !== locator.project_key) {
		throw new ValidationError("The active ticket-session locator does not match the recorded coordinator Git lineage.");
	}
	return identity;
}

function assertCoordinatorMutation(ctx: ExtensionContext, toolName: string): void {
	if (currentTicketSessionLocator(ctx.sessionManager) !== null) {
		throw new ValidationError(
			`${toolName} is a coordinator-only canonical mutation and cannot run from a dedicated executor session. Return to coordination first.`,
		);
	}
}

async function artifactReference(
	identity: any,
	workflowId: string,
	kind: typeof ARTIFACT_KINDS[number],
	artifactId: string | undefined,
	deps: ToolDependencies,
	homeDirectory: string,
): Promise<ArtifactReference> {
	if (kind === "workflow") {
		rejectValue(artifactId, "artifact_id");
		const workflow = await deps.inspectWorkflow(identity, workflowId, { homeDirectory });
		return { kind, id: workflow.id, path: workflow.path, digest: workflow.digest };
	}
	if (kind === "spec") {
		rejectValue(artifactId, "artifact_id");
		const spec = await deps.inspectSpec(identity, workflowId, { homeDirectory });
		return { kind, id: workflowId, path: spec.path, digest: spec.digest };
	}
	const id = requireValue(artifactId, "artifact_id");
	if (kind === "ticket") {
		const ticket = await deps.inspectTicket(identity, workflowId, id, { homeDirectory });
		return { kind, id: ticket.id, path: ticket.path, digest: ticket.digest };
	}
	if (kind === "decision") {
		const decision = await deps.inspectDecision(identity, workflowId, id, { homeDirectory });
		return { kind, id: decision.id, path: decision.path, digest: decision.digest };
	}
	const baseline = await deps.inspectBaseline(identity, workflowId, id, { homeDirectory });
	return { kind, id: baseline.id, path: baseline.path, digest: baseline.digest };
}

async function readArtifactSnapshot(reference: ArtifactReference, deps: ToolDependencies) {
	const snapshot = await deps.readFileWithDigest(reference.path, { encoding: "utf8" });
	if (snapshot.digest !== reference.digest) {
		throw new RevisionConflictError(
			`${reference.kind} '${reference.id}' changed while the selected artifact view was being read.`,
			{ details: { expected_digest: reference.digest, actual_digest: snapshot.digest } },
		);
	}
	return snapshot;
}

function inspectionValue(value: any): any {
	return {
		id: value.id,
		title: value.title,
		slug: value.slug,
		...(value.type === undefined ? {} : { type: value.type }),
		...(value.status === undefined ? {} : { status: value.status }),
		...(value.phase === undefined ? {} : { phase: value.phase }),
		...(value.conditions === undefined ? {} : { conditions: value.conditions }),
		...(value.current_baseline === undefined ? {} : { current_baseline: value.current_baseline }),
		...(value.spec_baseline === undefined ? {} : { spec_baseline: value.spec_baseline }),
		...(value.depends_on === undefined ? {} : { depends_on: value.depends_on }),
		...(value.execution === undefined ? {} : { execution: value.execution }),
		path: value.path,
		digest: value.digest,
		metadata: value.metadata,
	};
}

function sectionMapping(entries: Array<{ heading: string; content: string }>): Record<string, string> {
	const sections: Record<string, string> = {};
	for (const entry of entries) {
		if (Object.hasOwn(sections, entry.heading)) {
			throw new ValidationError(`Ticket section '${entry.heading}' is provided more than once.`);
		}
		sections[entry.heading] = entry.content;
	}
	return sections;
}

export function registerDbzWorkflowTools(
	pi: ExtensionAPI,
	{
		dependencies,
		homeDirectory = homedir(),
		fileMutationQueue = withFileMutationQueue,
	}: {
		dependencies?: Partial<ToolDependencies>;
		homeDirectory?: string;
		fileMutationQueue?: FileMutationQueue;
	} = {},
): void {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies } as ToolDependencies;

	pi.registerTool({
		name: "dbz_workflows_inspect",
		label: "Inspect DBZ Workflows",
		description: "List workflow or ticket metadata, or inspect one workflow or ticket, without returning artifact bodies.",
		promptSnippet: "Inspect DBZ Workflows workflow and ticket metadata without reading full bodies",
		parameters: Type.Object({
			action: StringEnum(INSPECTION_ACTIONS),
			workflow_id: Type.Optional(Type.String()),
			ticket_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			if (params.action === "list_workflows") {
				rejectValue(params.workflow_id, "workflow_id");
				rejectValue(params.ticket_id, "ticket_id");
				const workflows = await deps.listWorkflows(identity, { homeDirectory });
				return toolResult(params.action, workflows.map(inspectionValue));
			}
			const workflowId = requireValue(params.workflow_id, "workflow_id");
			if (params.action === "workflow") {
				rejectValue(params.ticket_id, "ticket_id");
				return toolResult(params.action, inspectionValue(
					await deps.inspectWorkflow(identity, workflowId, { homeDirectory }),
				));
			}
			if (params.action === "list_tickets") {
				rejectValue(params.ticket_id, "ticket_id");
				const tickets = await deps.listTickets(identity, workflowId, { homeDirectory });
				return toolResult(params.action, tickets.map(inspectionValue));
			}
			const ticketId = requireValue(params.ticket_id, "ticket_id");
			return toolResult(params.action, inspectionValue(
				await deps.inspectTicket(identity, workflowId, ticketId, { homeDirectory }),
			));
		},
	});

	const ArtifactParameters = {
		workflow_id: Type.String(),
		artifact: StringEnum(ARTIFACT_KINDS),
		artifact_id: Type.Optional(Type.String()),
	};

	pi.registerTool({
		name: "dbz_workflows_read_frontmatter",
		label: "Read DBZ Workflows Frontmatter",
		description: "Read validated frontmatter for one selected DBZ Workflows artifact without returning its Markdown body.",
		promptSnippet: "Read validated frontmatter for one selected DBZ Workflows artifact",
		parameters: Type.Object(ArtifactParameters),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			const reference = await artifactReference(
				identity,
				params.workflow_id,
				params.artifact,
				params.artifact_id,
				deps,
				homeDirectory,
			);
			const snapshot = await readArtifactSnapshot(reference, deps);
			return toolResult("read_frontmatter", {
				artifact: reference.kind,
				id: reference.id,
				path: reference.path,
				digest: reference.digest,
				frontmatter: readFrontmatter(snapshot.data, { path: reference.path }),
			});
		},
	});

	pi.registerTool({
		name: "dbz_workflows_read_section",
		label: "Read DBZ Workflows Section",
		description: "Read only one bounded level-two Markdown section from one selected validated DBZ Workflows artifact.",
		promptSnippet: "Read one selected DBZ Workflows Markdown section without unrelated sections",
		parameters: Type.Object({
			...ArtifactParameters,
			heading: Type.String(),
			include_heading: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			const reference = await artifactReference(
				identity,
				params.workflow_id,
				params.artifact,
				params.artifact_id,
				deps,
				homeDirectory,
			);
			const snapshot = await readArtifactSnapshot(reference, deps);
			return toolResult("read_section", {
				artifact: reference.kind,
				id: reference.id,
				path: reference.path,
				digest: reference.digest,
				heading: params.heading,
				content: readLevelTwoSection(snapshot.data, params.heading, {
					includeHeading: params.include_heading ?? false,
					path: reference.path,
				}),
			});
		},
	});

	pi.registerTool({
		name: "dbz_workflows_update_spec_sections",
		label: "Update DBZ Workflows Spec Sections",
		description: mutationDescription(
			"dbz_workflows_update_spec_sections",
			"replaces or appends only selected working-spec sections with optimistic revision guards",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_update_spec_sections"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			expected_workflow_digest: Type.String(),
			expected_spec_digest: Type.String(),
			updates: Type.Array(Type.Object({
				heading: Type.String(),
				content: Type.String(),
				operation: Type.Optional(StringEnum(["replace", "append"] as const)),
			}), { minItems: 1 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_update_spec_sections");
			const identity = await projectIdentity(ctx, deps);
			const spec = await deps.inspectSpec(identity, params.workflow_id, { homeDirectory });
			return runQueuedMutation([spec.path], async () => toolResult(
				"update_spec_sections",
				await deps.updateSpecDraftSections(identity, params.workflow_id, params.updates, {
					expectedWorkflowDigest: params.expected_workflow_digest,
					expectedSpecDigest: params.expected_spec_digest,
					homeDirectory,
				}),
			), fileMutationQueue);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_create_ticket",
		label: "Create DBZ Workflows Ticket",
		description: mutationDescription(
			"dbz_workflows_create_ticket",
			"allocates a canonical ticket and workflow counter under lock from a validated V1 contract",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_create_ticket"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			expected_workflow_digest: Type.String(),
			title: Type.String(),
			type: StringEnum(["research", "question-session", "design", "synthesis", "implementation", "documentation", "review", "verification"] as const),
			status: Type.Optional(StringEnum(["draft", "open"] as const)),
			research_class: Type.Optional(StringEnum(["baseline-blocking", "delivery"] as const)),
			spec_baseline: Type.Optional(Type.String()),
			depends_on: Type.Optional(Type.Array(Type.String())),
			execution: Type.Optional(Type.Object({
				mode: Type.Optional(StringEnum(["manual", "delegatable"] as const)),
				parallel_safe: Type.Optional(Type.Boolean()),
				conflicts_with: Type.Optional(Type.Array(Type.String())),
			})),
			context: Type.Optional(Type.Object({
				spec_sections: Type.Optional(Type.Array(Type.String())),
				decisions: Type.Optional(Type.Array(Type.String())),
				tickets: Type.Optional(Type.Array(Type.String())),
				files: Type.Optional(Type.Array(Type.String())),
			})),
			context_budget_exception: Type.Optional(Type.Object({
				justification: Type.String(),
				approved_by: StringEnum(["user"] as const),
				approved_at: Type.String(),
			})),
			sections: Type.Array(Type.Object({
				heading: Type.String(),
				content: Type.String(),
			})),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_create_ticket");
			const identity = await projectIdentity(ctx, deps);
			const context = await deps.resolveWorkflowArtifactContext(identity, params.workflow_id, { homeDirectory });
			const nextId = formatSequentialId("T", context.workflow.metadata.next_ticket_number);
			const candidatePath = resolve(
				context.paths.tickets,
				`${nextId}-${generateImmutableSlug(params.title, { fallback: "ticket" })}.md`,
			);
			const input = {
				title: params.title,
				type: params.type,
				...(params.status === undefined ? {} : { status: params.status }),
				...(params.research_class === undefined ? {} : { research_class: params.research_class }),
				...(params.spec_baseline === undefined ? {} : { spec_baseline: params.spec_baseline }),
				...(params.depends_on === undefined ? {} : { depends_on: params.depends_on }),
				...(params.execution === undefined ? {} : { execution: params.execution }),
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.context_budget_exception === undefined
					? {}
					: { context_budget_exception: params.context_budget_exception }),
				sections: sectionMapping(params.sections),
			};
			return runQueuedMutation([context.workflow.path, candidatePath], async () => toolResult(
				"create_ticket",
				await deps.createTicket(identity, params.workflow_id, input, {
					expectedWorkflowDigest: params.expected_workflow_digest,
					homeDirectory,
					contextWindowTokens: ctx.model?.contextWindow,
				}),
			), fileMutationQueue);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_transition_ticket",
		label: "Transition DBZ Workflows Ticket",
		description: mutationDescription(
			"dbz_workflows_transition_ticket",
			"applies a valid non-completion ticket transition with required rationale and revision guards",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_transition_ticket"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_id: Type.String(),
			expected_ticket_digest: Type.String(),
			to_status: StringEnum(["open", "blocked", "cancelled", "superseded"] as const),
			rationale: Type.Optional(Type.String()),
			superseded_by: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_transition_ticket");
			const identity = await projectIdentity(ctx, deps);
			const ticket = await deps.inspectTicket(identity, params.workflow_id, params.ticket_id, { homeDirectory });
			return runQueuedMutation([ticket.path], async () => toolResult(
				"transition_ticket",
				await deps.transitionTicketStatus(identity, params.workflow_id, params.ticket_id, params.to_status, {
					expectedTicketDigest: params.expected_ticket_digest,
					rationale: params.rationale,
					supersededBy: params.superseded_by,
					homeDirectory,
					contextWindowTokens: ctx.model?.contextWindow,
				}),
			), fileMutationQueue);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_query_actionable",
		label: "Query DBZ Workflows Actionable Tickets",
		description: "Validate the canonical ticket DAG and calculate derived readiness, staleness, conflicts, and actionable ticket IDs.",
		promptSnippet: "Validate a workflow ticket DAG and query derived actionable tickets",
		parameters: Type.Object({ workflow_id: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			const tickets = await deps.listTickets(identity, params.workflow_id, { homeDirectory });
			const [dag, readiness] = await Promise.all([
				deps.validateTicketDag(tickets, { workflowId: params.workflow_id }),
				deps.queryTicketReadiness(identity, params.workflow_id, {
					homeDirectory,
					contextWindowTokens: ctx.model?.contextWindow,
				}),
			]);
			return toolResult("query_actionable", { dag, readiness });
		},
	});

	pi.registerTool({
		name: "dbz_workflows_plan_wave",
		label: "Plan DBZ Workflows Wave",
		description: "Plan an explicit bounded manual scheduler wave without claiming or dispatching tickets.",
		promptSnippet: "Plan a DBZ Workflows execution wave without dispatching it",
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_ids: Type.Optional(Type.Array(Type.String())),
			max_concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			return toolResult("plan_wave", await deps.planSchedulerWave(identity, params.workflow_id, {
				homeDirectory,
				executor: "manual",
				requestedTicketIds: params.ticket_ids,
				maxConcurrency: params.max_concurrency,
				contextWindowTokens: ctx.model?.contextWindow,
			}));
		},
	});

	pi.registerTool({
		name: "dbz_workflows_claim_ticket",
		label: "Claim DBZ Workflows Ticket",
		description: mutationDescription(
			"dbz_workflows_claim_ticket",
			"creates a durable manual claim for the current dedicated Pi session and moves an actionable ticket in-progress",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_claim_ticket"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_id: Type.String(),
			expected_ticket_digest: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_claim_ticket");
			const identity = await projectIdentity(ctx, deps);
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) throw new ValidationError("dbz_workflows_claim_ticket requires a persistent Pi session ID.");
			const ticket = await deps.inspectTicket(identity, params.workflow_id, params.ticket_id, { homeDirectory });
			if (isProjectMutatingTicket(ticket.metadata)) {
				throw new ValidationError(
					"Implementation and documentation tickets must be dispatched with /dbz-workflows run so their complete ticket-worktree Git plan is reviewed and applied before claiming.",
				);
			}
			return runQueuedMutation([ticket.path], async () => toolResult(
				"claim_ticket",
				await deps.startManualExecution(identity, params.workflow_id, params.ticket_id, {
					expectedTicketDigest: params.expected_ticket_digest,
					sessionId,
					homeDirectory,
					contextWindowTokens: ctx.model?.contextWindow,
				}),
			), fileMutationQueue);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_recover_claim",
		label: "Recover DBZ Workflows Claim",
		description: mutationDescription(
			"dbz_workflows_recover_claim",
			"prompts for explicit human confirmation before recovering one durable abandoned claim",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_recover_claim"),
		executionMode: "sequential",
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_id: Type.String(),
			expected_ticket_digest: Type.String(),
			rationale: Type.String(),
			to_status: Type.Optional(StringEnum(["open", "blocked"] as const)),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_recover_claim");
			const identity = await projectIdentity(ctx, deps);
			assertDialogUI(ctx, "DBZ Workflows claim recovery");
			const ticket = await deps.inspectTicket(identity, params.workflow_id, params.ticket_id, { homeDirectory });
			const claimId = ticket.execution?.claim?.claim_id;
			if (!claimId) throw new ValidationError(`Ticket '${params.ticket_id}' has no recoverable claim ID.`);
			const confirmed = await ctx.ui.confirm(
				`Recover claim for ${params.ticket_id}?`,
				`Active claim: ${claimId}\nTarget status: ${params.to_status ?? "open"}\nReason: ${params.rationale}\n\nClaims never expire automatically. Recover only after confirming the previous executor is abandoned.`,
			);
			if (!confirmed) throw new ValidationError("Claim recovery was not confirmed and no canonical state was changed.");
			return runQueuedMutation([ticket.path], async () => toolResult(
				"recover_claim",
				await deps.recoverTicketClaim(identity, params.workflow_id, params.ticket_id, {
					expectedTicketDigest: params.expected_ticket_digest,
					rationale: params.rationale,
					toStatus: params.to_status ?? "open",
					authorization: { confirmed: true, recovered_by: "user", claim_id: claimId },
					homeDirectory,
				}),
			), fileMutationQueue);
		},
	});

	const ResultFields = {
		summary: Type.String(),
		deliverables: Type.String(),
		acceptance_criteria_evidence: Type.String(),
		validation: Type.String(),
		deviations: Type.String(),
		follow_ups: Type.String(),
		worker_commits: Type.Optional(Type.Array(Type.String())),
	};

	pi.registerTool({
		name: "dbz_workflows_submit_result",
		label: "Submit DBZ Workflows Result",
		description: mutationDescription(
			"dbz_workflows_submit_result",
			"submits a normalized executor result for the current session without granting canonical completion authority",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_submit_result"),
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_id: Type.String(),
			expected_ticket_digest: Type.String(),
			outcome: StringEnum(["done", "blocked", "failed"] as const),
			reason: Type.Optional(Type.String()),
			failed_disposition: Type.Optional(StringEnum(["open", "blocked"] as const)),
			...ResultFields,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await projectIdentity(ctx, deps);
			const ticket = await deps.inspectTicket(identity, params.workflow_id, params.ticket_id, { homeDirectory });
			const locator = currentTicketSessionLocator(ctx.sessionManager);
			if (isProjectMutatingTicket(ticket.metadata)) {
				if (
					locator === null ||
					!locator.mutates_project ||
					locator.workflow_id !== params.workflow_id ||
					locator.ticket_id !== params.ticket_id ||
					resolve(ctx.cwd) !== locator.ticket_worktree
				) {
					throw new ValidationError(
						"A mutating result may be submitted only from its claimed dedicated Pi session running in the applied ticket worktree.",
					);
				}
			}
			const result = createCurrentSessionExecutorResult(ctx, ticket, params, deps.createExecutorResult);
			return runQueuedMutation([ticket.path], async () => toolResult(
				"submit_result",
				submittedResultResponse(
					await deps.applyExecutorResult(identity, params.workflow_id, params.ticket_id, result, {
						expectedTicketDigest: params.expected_ticket_digest,
						failedDisposition: params.failed_disposition,
						homeDirectory,
					}),
					params.workflow_id,
					params.ticket_id,
				),
			), fileMutationQueue);
		},
	});

	pi.registerTool({
		name: "dbz_workflows_accept_result",
		label: "Accept DBZ Workflows Result",
		description: mutationDescription(
			"dbz_workflows_accept_result",
			"records coordinator evidence and completes a done ticket only after core acceptance checks",
		),
		promptGuidelines: mutationGuidelines("dbz_workflows_accept_result"),
		executionMode: "sequential",
		parameters: Type.Object({
			workflow_id: Type.String(),
			ticket_id: Type.String(),
			expected_ticket_digest: Type.String(),
			deliverables_verified: Type.Boolean(),
			acceptance_criteria_verified: Type.Boolean(),
			validation_verified: Type.Boolean(),
			integrated_commits: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			assertCoordinatorMutation(ctx, "dbz_workflows_accept_result");
			const identity = await projectIdentity(ctx, deps);
			const ticket = await deps.inspectTicket(identity, params.workflow_id, params.ticket_id, { homeDirectory });
			const humanApproval = await prepareCoordinatorAcceptance(ctx, ticket);
			return runQueuedMutation([ticket.path], async () => toolResult(
				"accept_result",
				await deps.acceptExecutorResult(identity, params.workflow_id, params.ticket_id, {
					deliverables_verified: params.deliverables_verified,
					acceptance_criteria_verified: params.acceptance_criteria_verified,
					validation_verified: params.validation_verified,
					integrated_commits: params.integrated_commits ?? [],
				}, {
					expectedTicketDigest: params.expected_ticket_digest,
					humanApproval,
					homeDirectory,
				}),
			), fileMutationQueue);
		},
	});
}
