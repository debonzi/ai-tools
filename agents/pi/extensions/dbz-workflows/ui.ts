import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { diagnosticFromError } from "../../../../skills/dbz-workflows/lib/errors.mjs";

export type StorageMode = "project" | "managed" | "external";

const STORAGE_OPTIONS: ReadonlyArray<{
	mode: StorageMode;
	label: string;
}> = [
	{ mode: "project", label: "Project-local — <project>/dbz-workflows" },
	{ mode: "managed", label: "Managed — ~/.local/share/dbz-workflows/projects/<project-key>" },
	{ mode: "external", label: "External — use one exact absolute path" },
];

export function assertTrustedProject(ctx: ExtensionContext): void {
	if (!ctx.isProjectTrusted()) {
		throw new Error(
			"DBZ Workflows requires a trusted project context. Trust this project explicitly and retry the command or tool.",
		);
	}
}

export function assertDialogUI(ctx: ExtensionContext, operation: string): void {
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error(
			`${operation} requires interactive confirmation through Pi TUI or RPC UI. ` +
			"Print and JSON modes never assume confirmation; retry in TUI/RPC mode or use a reviewed deterministic CLI apply operation.",
		);
	}
}

export function boundedText(value: string): string {
	const result = truncateHead(value, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!result.truncated) return result.content;
	const suffix = "\n\n[Output truncated to Pi's 50 KB / 2,000-line limit.]";
	return truncateHead(`${result.content}${suffix}`, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	}).content;
}

export function formatError(error: unknown): string {
	const diagnostic = diagnosticFromError(error);
	const issues = Array.isArray(diagnostic.details?.issues)
		? diagnostic.details.issues
			.slice(0, 3)
			.map((issue: { path?: unknown[]; message?: unknown }) => {
				const path = Array.isArray(issue.path) ? issue.path.join(".") : "artifact";
				return `- ${path}: ${String(issue.message ?? "invalid value")}`;
			})
		: [];
	return boundedText([
		`DBZ Workflows error [${diagnostic.code}]: ${diagnostic.message}`,
		...(issues.length === 0 ? [] : ["", ...issues]),
	].join("\n"));
}

export async function promptStorageMode(
	ctx: ExtensionContext,
	{ currentMode, allowKeep = false }: { currentMode?: StorageMode; allowKeep?: boolean } = {},
): Promise<StorageMode | "keep" | undefined> {
	const labels = [
		...(allowKeep && currentMode
			? [`Keep current ${currentMode} storage (no changes)`]
			: []),
		...STORAGE_OPTIONS.map(({ label }) => label),
	];
	const selected = await ctx.ui.select("DBZ Workflows storage", labels);
	if (selected === undefined) return undefined;
	if (selected.startsWith("Keep current ")) return "keep";
	return STORAGE_OPTIONS.find(({ label }) => label === selected)?.mode;
}

export async function promptExternalPath(ctx: ExtensionContext): Promise<string | undefined> {
	const value = await ctx.ui.input(
		"Exact external DBZ Workflows storage path",
		"/absolute/path/to/dbz-workflows",
	);
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function formatSetupPlan(plan: any): string {
	const changes = Array.isArray(plan.changes) && plan.changes.length > 0
		? plan.changes.map((change: any) => `- ${change.action}: ${change.path ?? change.to ?? ""}`.trimEnd())
		: ["- No file changes (configuration is already active)."];
	return boundedText([
		`Mode: ${plan.mode}`,
		`Action: ${plan.action}`,
		`Selected path: ${plan.destination.selected_path}`,
		`Effective path: ${plan.destination.effective_path}`,
		...(plan.lineage_notice?.message ? ["", plan.lineage_notice.message] : []),
		"",
		"Planned changes:",
		...changes,
	].join("\n"));
}

export function formatMigrationPlan(plan: any): string {
	const changes = Array.isArray(plan.changes) && plan.changes.length > 0
		? plan.changes.map((change: any) => {
			const path = change.path ?? change.to ?? "";
			return `- ${change.action}${path ? `: ${path}` : ""}`;
		})
		: ["- No changes (the selected storage is already active)."];
	return boundedText([
		plan.disclaimer,
		"",
		`Source: ${plan.source.mode} — ${plan.source.selected_path}`,
		`Destination: ${plan.destination.mode} — ${plan.destination.selected_path}`,
		`Effective destination: ${plan.destination.effective_path}`,
		...(plan.action === "noop" ? [] : [`Preserved backup: ${plan.backup_path}`]),
		"",
		"Planned changes:",
		...changes,
	].join("\n"));
}

function formatConditions(conditions: unknown): string {
	return Array.isArray(conditions) && conditions.length > 0 ? conditions.join(", ") : "none";
}

export function formatWorkflowList(workflows: any[]): string {
	if (workflows.length === 0) return "No DBZ Workflows workflows exist in the active storage root.";
	return boundedText([
		"DBZ Workflows workflows",
		...workflows.map((workflow) =>
			`${workflow.id} · ${workflow.phase} · ${workflow.title} · conditions: ${formatConditions(workflow.conditions)}`,
		),
	].join("\n"));
}

export function formatWorkflowDashboard(
	workflow: any,
	tickets: any[],
	readiness: any,
): string {
	const actionable = new Set(readiness?.actionable_ticket_ids ?? []);
	const ticketLines = tickets.length === 0
		? ["- No tickets."]
		: tickets.map((ticket) => {
			const marker = actionable.has(ticket.id) ? "actionable" : ticket.status;
			const claim = ticket.execution?.claim ? ` · claimed by ${ticket.execution.claim.executor}` : "";
			return `- ${ticket.id} · ${marker} · ${ticket.type} · ${ticket.title}${claim}`;
		});
	return boundedText([
		`${workflow.id}: ${workflow.title}`,
		`Phase: ${workflow.phase}`,
		`Conditions: ${formatConditions(workflow.conditions)}`,
		`Current baseline: ${workflow.current_baseline ?? "none"}`,
		`Workflow branch: ${workflow.metadata?.git?.workflow_branch ?? "unknown"}`,
		`Actionable tickets: ${(readiness?.actionable_ticket_ids ?? []).join(", ") || "none"}`,
		"",
		"Tickets:",
		...ticketLines,
	].join("\n"));
}

export function workflowChoiceLabel(workflow: any): string {
	return `${workflow.id} · ${workflow.phase} · ${workflow.title}`;
}

export function ticketChoiceLabel(ticket: any): string {
	return `${ticket.id} · ${ticket.type} · ${ticket.title}`;
}
