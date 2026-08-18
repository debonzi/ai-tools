export interface CopilotUsageConfig {
	refreshIntervalMinutes: number;
}

export type CopilotQuotaKind = "ai-credits" | "premium-requests" | "chat-requests";

export interface CopilotQuota {
	id: CopilotQuotaKind;
	label: string;
	used?: number;
	remaining?: number;
	limit?: number;
	unlimited: boolean;
	resetsAt?: number;
}

export interface CopilotUsageReport {
	capturedAt: number;
	accountLabel?: string;
	plan?: string;
	quota: CopilotQuota;
	additionalUsage?: number;
}

export const DEFAULT_CONFIG: Readonly<CopilotUsageConfig> = {
	refreshIntervalMinutes: 5,
};

const BAR_SEGMENTS = 20;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 1440;

export function parseConfig(value: unknown): {
	config: CopilotUsageConfig;
	warnings: string[];
} {
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	if (value === undefined) return { config, warnings };
	if (!isObject(value)) {
		return {
			config,
			warnings: ["copilot-usage config must be a JSON object; using defaults."],
		};
	}

	if (value.refreshIntervalMinutes !== undefined) {
		const interval = value.refreshIntervalMinutes;
		if (
			typeof interval === "number" &&
			Number.isSafeInteger(interval) &&
			interval >= MIN_REFRESH_MINUTES &&
			interval <= MAX_REFRESH_MINUTES
		) {
			config.refreshIntervalMinutes = interval;
		} else {
			warnings.push(
				`refreshIntervalMinutes must be an integer between ${MIN_REFRESH_MINUTES} and ${MAX_REFRESH_MINUTES}; using 5.`,
			);
		}
	}

	return { config, warnings };
}

export function normalizeCopilotUsage(
	payload: unknown,
	capturedAt = Date.now(),
): CopilotUsageReport {
	if (!isObject(payload)) throw new Error("GitHub Copilot usage response was not an object.");

	const snapshots = asObject(payload.quota_snapshots);
	const premium = asObject(snapshots?.premium_interactions);
	let quota: CopilotQuota;
	let additionalUsage: number | undefined;

	if (premium) {
		const tokenBasedBilling = premium.token_based_billing === true;
		const id = tokenBasedBilling ? "ai-credits" : "premium-requests";
		const label = tokenBasedBilling ? "AI credits" : "Premium requests";

		if (premium.unlimited === true) {
			quota = { id, label, unlimited: true };
		} else {
			const limit = nonnegativeNumber(premium.entitlement);
			const rawRemaining =
				finiteNumber(premium.remaining) ?? finiteNumber(premium.quota_remaining);
			if (limit === undefined || rawRemaining === undefined) {
				throw new Error(`GitHub Copilot ${label.toLowerCase()} quota was incomplete.`);
			}
			additionalUsage = Math.max(
				nonnegativeNumber(premium.overage_count) ?? 0,
				Math.max(0, -rawRemaining),
			);
			quota = {
				id,
				label,
				used:
					nonnegativeNumber(premium.credits_used) ?? Math.max(0, limit - rawRemaining),
				remaining: Math.max(0, rawRemaining),
				limit,
				unlimited: false,
				...resetTimestamp(payload),
			};
		}
	} else {
		const limited = asObject(payload.limited_user_quotas);
		const monthly = asObject(payload.monthly_quotas);
		const remaining = nonnegativeNumber(limited?.chat);
		const limit = nonnegativeNumber(monthly?.chat);
		if (remaining === undefined || limit === undefined) {
			throw new Error("GitHub Copilot usage response contained no supported quota.");
		}
		quota = {
			id: "chat-requests",
			label: "Chat requests",
			used: Math.max(0, limit - remaining),
			remaining,
			limit,
			unlimited: false,
			...resetTimestamp(payload),
		};
	}

	const accountLabel = optionalText(payload.login);
	const plan = optionalText(payload.copilot_plan) ?? optionalText(payload.access_type_sku);
	return {
		capturedAt,
		...(accountLabel ? { accountLabel } : {}),
		...(plan ? { plan } : {}),
		quota,
		...(additionalUsage !== undefined && additionalUsage > 0 ? { additionalUsage } : {}),
	};
}

export function formatUsageStatusline(report: CopilotUsageReport): string {
	const quota = report.quota;
	const kind = quota.id === "ai-credits" ? "credits" : quota.id === "chat-requests" ? "chat" : "premium";
	if (quota.unlimited || quota.limit === undefined || quota.remaining === undefined) {
		return `copilot ${kind} unlimited`;
	}
	const label = kind === "premium" ? "" : `${kind} `;
	const overage = report.additionalUsage ? ` +${formatCount(report.additionalUsage)} over` : "";
	return `copilot ${label}${formatCount(quota.remaining)}/${formatCount(quota.limit)} ${percentRemaining(quota)}%${overage}`;
}

export function formatUsageReport(
	report: CopilotUsageReport,
	model: { id: string },
): string {
	const quota = report.quota;
	const lines = ["GitHub Copilot Usage"];
	if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
	if (report.plan) lines.push(`Plan: ${report.plan}`);
	lines.push(`Current model: ${sanitizeText(model.id, 160)}`, "");

	if (quota.unlimited || quota.limit === undefined || quota.remaining === undefined) {
		lines.push(`${quota.label}: unlimited`);
	} else {
		const reset = quota.resetsAt ? ` · resets ${formatResetAt(quota.resetsAt)}` : "";
		lines.push(
			`${quota.label}: ${formatPercentBar(percentRemaining(quota))} ${formatCount(quota.remaining)} of ${formatCount(quota.limit)} left · ${percentRemaining(quota)}%${reset}`,
		);
		if (quota.used !== undefined) lines.push(`Used: ${formatCount(quota.used)}`);
	}
	if (report.additionalUsage !== undefined) {
		lines.push(`Additional usage: ${formatCount(report.additionalUsage)} ${quota.label}`);
	}
	return lines.join("\n").trimEnd();
}

export function formatResetAt(epochSeconds: number): string {
	const date = new Date(epochSeconds * 1000);
	if (Number.isNaN(date.getTime())) return "unknown";
	const month = date.toLocaleDateString("en-US", { month: "short" });
	const day = date.getDate();
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	return `${month} ${day} ${hours}:${minutes}`;
}

function resetTimestamp(payload: Record<string, unknown>): { resetsAt?: number } {
	const raw =
		optionalText(payload.quota_reset_date_utc) ??
		optionalText(payload.quota_reset_date) ??
		optionalText(payload.limited_user_reset_date);
	if (!raw) return {};
	const milliseconds = Date.parse(raw);
	return Number.isNaN(milliseconds) ? {} : { resetsAt: Math.floor(milliseconds / 1000) };
}

function percentRemaining(quota: CopilotQuota): number {
	if (!quota.limit || quota.remaining === undefined) return 0;
	return Math.round(clampPercent((quota.remaining / quota.limit) * 100));
}

function formatPercentBar(percent: number): string {
	const filled = Math.round((clampPercent(percent) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatCount(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function optionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeText(value, 80) || undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number === undefined || number < 0 ? undefined : number;
}

function sanitizeText(value: string, maxLength: number): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, maxLength);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
