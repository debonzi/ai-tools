export interface CodexUsageConfig {
	showOtherModels: boolean;
	refreshIntervalMinutes: number;
}

export interface CodexUsageWindow {
	id: "primary" | "secondary";
	usedPercent: number;
	remainingPercent: number;
	windowSeconds?: number;
	resetsAt?: number;
}

export interface CodexUsageGroup {
	id: string;
	label: string;
	modelKeys: string[];
	windows: CodexUsageWindow[];
}

export interface CodexCredits {
	hasCredits?: boolean;
	unlimited?: boolean;
	balance?: number | string;
}

export interface CodexResetCredits {
	available?: number;
	usable?: number;
}

export interface CodexUsageReport {
	capturedAt: number;
	accountLabel?: string;
	plan?: string;
	groups: CodexUsageGroup[];
	credits?: CodexCredits;
	resetCredits?: CodexResetCredits;
}

export interface UsageModel {
	provider: string;
	id: string;
	name?: string;
}

export interface SelectedUsageGroups {
	groups: CodexUsageGroup[];
	selectedGroupId?: string;
}

export const DEFAULT_CONFIG: Readonly<CodexUsageConfig> = {
	showOtherModels: false,
	refreshIntervalMinutes: 5,
};

const BAR_SEGMENTS = 20;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 1440;

export function parseConfig(value: unknown): {
	config: CodexUsageConfig;
	warnings: string[];
} {
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	if (value === undefined) return { config, warnings };
	if (!isObject(value)) {
		return {
			config,
			warnings: ["codex-usage config must be a JSON object; using defaults."],
		};
	}

	if (value.showOtherModels !== undefined) {
		if (typeof value.showOtherModels === "boolean") {
			config.showOtherModels = value.showOtherModels;
		} else {
			warnings.push("showOtherModels must be a boolean; using false.");
		}
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

export function normalizeCodexUsage(payload: unknown, capturedAt = Date.now()): CodexUsageReport {
	if (!isObject(payload)) throw new Error("Codex usage response was not an object.");

	const groups: CodexUsageGroup[] = [];
	const primary = normalizeGroup("codex", "Codex", payload.rate_limit);
	if (primary) groups.push(primary);

	if (Array.isArray(payload.additional_rate_limits)) {
		for (const rawEntry of payload.additional_rate_limits) {
			const entry = isObject(rawEntry) ? rawEntry : undefined;
			if (!entry) continue;
			const id = optionalText(entry.metered_feature) ?? optionalText(entry.limit_name);
			const label = optionalText(entry.limit_name) ?? id;
			if (!id || !label) continue;
			const group = normalizeGroup(id, label, entry.rate_limit);
			if (group) groups.push(group);
		}
	}

	const credits = normalizeCredits(payload.credits);
	const resetCredits = normalizeResetCredits(payload.rate_limit_reset_credits);
	if (groups.length === 0 && !credits && !resetCredits) {
		throw new Error("Codex usage response contained no displayable usage data.");
	}

	const email = optionalText(payload.email);
	const accountLabel = emailLocalPart(email);
	const plan = optionalText(payload.plan_type);

	return {
		capturedAt,
		...(accountLabel ? { accountLabel } : {}),
		...(plan ? { plan } : {}),
		groups,
		...(credits ? { credits } : {}),
		...(resetCredits ? { resetCredits } : {}),
	};
}

export function selectUsageGroups(
	report: CodexUsageReport,
	model: UsageModel,
	showOtherModels: boolean,
): SelectedUsageGroups {
	if (report.groups.length === 0) return { groups: [] };

	const modelKeys = normalizedModelKeys(model);
	const matched = report.groups.find(
		(group) => group.id !== "codex" && groupMatchesModel(group, modelKeys),
	);
	const selected = matched ?? report.groups.find((group) => group.id === "codex") ?? report.groups[0];
	if (!selected) return { groups: [] };

	return {
		groups: showOtherModels
			? [selected, ...report.groups.filter((group) => group !== selected)]
			: [selected],
		selectedGroupId: selected.id,
	};
}

export function formatUsageStatusline(
	report: CodexUsageReport,
	model: UsageModel,
	showOtherModels: boolean,
): string {
	const selection = selectUsageGroups(report, model, showOtherModels);
	const groupParts = selection.groups
		.map((group) => formatStatusGroup(group))
		.filter((part): part is string => Boolean(part));

	let status = groupParts.join(" | ");
	if (!status) status = formatCreditsStatus(report.credits);
	const resetCredits = formatResetCreditsCompact(report.resetCredits);
	if (resetCredits) status += ` · ${resetCredits}`;
	return status;
}

export function formatUsageReport(report: CodexUsageReport, model: UsageModel): string {
	const selection = selectUsageGroups(report, model, true);
	const selectedId = selection.selectedGroupId;
	const lines = ["OpenAI Codex Usage"];
	if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
	if (report.plan) lines.push(`Plan: ${report.plan}`);
	lines.push(`Current model: ${model.id}`, "");

	for (const group of selection.groups) {
		const marker = group.id === selectedId ? " · selected" : "";
		lines.push(`${group.label} limit${marker}:`);
		for (const window of group.windows) {
			const duration = formatWindowDuration(window.windowSeconds, window.id);
			const reset = window.resetsAt ? ` · resets ${formatResetAt(window.resetsAt)}` : "";
			lines.push(
				`  ${duration}: ${formatPercentBar(window.remainingPercent)} ${window.remainingPercent.toFixed(0)}% left${reset}`,
			);
		}
	}

	if (report.resetCredits) {
		const values: string[] = [];
		if (report.resetCredits.available !== undefined) {
			values.push(`${report.resetCredits.available} available`);
		}
		if (report.resetCredits.usable !== undefined) {
			values.push(`${report.resetCredits.usable} usable`);
		}
		if (values.length > 0) lines.push("", `Reset credits: ${values.join(" · ")}`);
	}

	if (report.credits) {
		lines.push(`Credits: ${formatCreditsDetail(report.credits)}`);
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

export function emailLocalPart(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const at = email.indexOf("@");
	if (at <= 0) return undefined;
	return sanitizeText(email.slice(0, at), 80) || undefined;
}

function normalizeGroup(
	id: string,
	label: string,
	rawRateLimit: unknown,
): CodexUsageGroup | undefined {
	if (!isObject(rawRateLimit)) return undefined;
	const windows: CodexUsageWindow[] = [];
	const primary = normalizeWindow("primary", rawRateLimit.primary_window);
	const secondary = normalizeWindow("secondary", rawRateLimit.secondary_window);
	if (primary) windows.push(primary);
	if (secondary) windows.push(secondary);
	if (windows.length === 0) return undefined;
	return {
		id: sanitizeText(id, 160),
		label: sanitizeText(label, 160),
		modelKeys: [id, label].map((value) => sanitizeText(value, 160)),
		windows,
	};
}

function normalizeWindow(
	id: "primary" | "secondary",
	rawWindow: unknown,
): CodexUsageWindow | undefined {
	if (!isObject(rawWindow)) return undefined;
	const used = optionalNumber(rawWindow.used_percent);
	if (used === undefined) return undefined;
	const usedPercent = clampPercent(used);
	const windowSeconds = optionalNumber(rawWindow.limit_window_seconds);
	const resetsAt = optionalNumber(rawWindow.reset_at);
	return {
		id,
		usedPercent,
		remainingPercent: 100 - usedPercent,
		...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
		...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
	};
}

function normalizeCredits(rawCredits: unknown): CodexCredits | undefined {
	if (!isObject(rawCredits)) return undefined;
	const hasCredits =
		typeof rawCredits.has_credits === "boolean" ? rawCredits.has_credits : undefined;
	const unlimited = typeof rawCredits.unlimited === "boolean" ? rawCredits.unlimited : undefined;
	const balance = optionalNumber(rawCredits.balance) ?? optionalText(rawCredits.balance);
	if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balance !== undefined ? { balance } : {}),
	};
}

function normalizeResetCredits(rawResetCredits: unknown): CodexResetCredits | undefined {
	if (!isObject(rawResetCredits)) return undefined;
	const available = optionalNonnegativeInteger(rawResetCredits.available_count);
	const usable = optionalNonnegativeInteger(rawResetCredits.applicable_available_count);
	if (available === undefined && usable === undefined) return undefined;
	return {
		...(available !== undefined ? { available } : {}),
		...(usable !== undefined ? { usable } : {}),
	};
}

function formatStatusGroup(group: CodexUsageGroup): string | undefined {
	if (group.windows.length === 0) return undefined;
	const label = group.id === "codex" ? "codex" : `codex ${compactGroupLabel(group.label)}`;
	const windows = group.windows.map((window) => {
		let value = `${window.remainingPercent.toFixed(0)}% ${formatWindowDuration(window.windowSeconds, window.id, true)}`;
		if (window.resetsAt) value += ` reset ${formatResetAt(window.resetsAt)}`;
		return value;
	});
	return `${label} ${windows.join(" · ")}`;
}

function formatResetCreditsCompact(resetCredits: CodexResetCredits | undefined): string | undefined {
	if (!resetCredits) return undefined;
	if (resetCredits.available !== undefined && resetCredits.usable !== undefined) {
		return `resets ${resetCredits.available} (${resetCredits.usable} usable)`;
	}
	if (resetCredits.available !== undefined) return `resets ${resetCredits.available}`;
	if (resetCredits.usable !== undefined) return `resets ${resetCredits.usable} usable`;
	return undefined;
}

function formatCreditsStatus(credits: CodexCredits | undefined): string {
	if (!credits) return "codex usage unavailable";
	if (credits.unlimited) return "codex credits unlimited";
	if (credits.hasCredits === false) return "codex no credits";
	if (credits.balance !== undefined) return `codex ${credits.balance} credits`;
	if (credits.hasCredits) return "codex credits available";
	return "codex usage unavailable";
}

function formatCreditsDetail(credits: CodexCredits): string {
	if (credits.unlimited) return "unlimited";
	if (credits.hasCredits === false) return "none";
	if (credits.balance !== undefined) return String(credits.balance);
	if (credits.hasCredits) return "available";
	return "unavailable";
}

function formatPercentBar(remainingPercent: number): string {
	const filled = Math.round((clampPercent(remainingPercent) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatWindowDuration(
	seconds: number | undefined,
	fallback: "primary" | "secondary",
	compact = false,
): string {
	if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
		return fallback === "secondary" ? (compact ? "wk" : "Weekly") : "5h";
	}
	if (seconds === 604_800) return compact ? "wk" : "Weekly";
	if (seconds % 604_800 === 0) return `${seconds / 604_800}w`;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return `${Math.ceil(seconds / 60)}m`;
}

function compactGroupLabel(label: string): string {
	const normalized = label.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
	const codexMatch = /\bcodex\s+/iu.exec(normalized);
	const suffix = codexMatch ? normalized.slice(codexMatch.index + codexMatch[0].length) : normalized;
	return (suffix || normalized).toLowerCase();
}

function normalizedModelKeys(model: UsageModel): Set<string> {
	const keys = new Set<string>();
	for (const raw of [model.id, model.name]) {
		const key = normalizeKey(raw);
		if (!key) continue;
		keys.add(key);
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}
	return keys;
}

function groupMatchesModel(group: CodexUsageGroup, modelKeys: Set<string>): boolean {
	for (const raw of [group.id, group.label, ...group.modelKeys]) {
		const key = normalizeKey(raw);
		if (!key) continue;
		if (modelKeys.has(key)) return true;
		for (const modelKey of modelKeys) {
			if (modelKey.endsWith(`-${key}`) || key.endsWith(`-${modelKey}`)) return true;
		}
	}
	return false;
}

function normalizeKey(value: string | undefined): string | undefined {
	const key = value?.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
	return key || undefined;
}

function optionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeText(value, 200) || undefined;
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
	const parsed = optionalNumber(value);
	if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

function sanitizeText(value: string, maxLength: number): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, maxLength);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
