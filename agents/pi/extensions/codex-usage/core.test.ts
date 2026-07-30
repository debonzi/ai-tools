import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	emailLocalPart,
	formatResetAt,
	formatUsageReport,
	formatUsageStatusline,
	normalizeCodexUsage,
	parseConfig,
	selectUsageGroups,
} from "./core.ts";

const GENERAL_RESET = Date.UTC(2026, 7, 5, 1, 13) / 1000;
const SPARK_RESET = Date.UTC(2026, 7, 6, 15, 12) / 1000;

const payload = {
	user_id: "user-opaque",
	account_id: "user-opaque",
	email: "debonzi@example.com",
	plan_type: "prolite",
	rate_limit: {
		primary_window: {
			used_percent: 15,
			limit_window_seconds: 604_800,
			reset_at: GENERAL_RESET,
		},
		secondary_window: null,
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			metered_feature: "codex_bengalfox",
			rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604_800,
					reset_at: SPARK_RESET,
				},
			},
		},
	],
	credits: {
		has_credits: false,
		unlimited: false,
		balance: "0",
	},
	rate_limit_reset_credits: {
		available_count: 2,
		applicable_available_count: 0,
	},
};

const defaultModel = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
};

const sparkModel = {
	provider: "openai-codex",
	id: "gpt-5.3-codex-spark",
	name: "GPT-5.3 Codex Spark",
};

test("uses defaults for missing config", () => {
	assert.deepEqual(parseConfig(undefined), {
		config: DEFAULT_CONFIG,
		warnings: [],
	});
});

test("accepts valid config boundaries", () => {
	assert.deepEqual(
		parseConfig({ showOtherModels: true, refreshIntervalMinutes: 1 }).config,
		{ showOtherModels: true, refreshIntervalMinutes: 1 },
	);
	assert.equal(parseConfig({ refreshIntervalMinutes: 1440 }).config.refreshIntervalMinutes, 1440);
});

test("falls back for invalid config values", () => {
	const result = parseConfig({ showOtherModels: "yes", refreshIntervalMinutes: 0 });
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.equal(result.warnings.length, 2);
});

test("normalizes primary, model-specific, account, and reset data", () => {
	const report = normalizeCodexUsage(payload, 123);
	assert.equal(report.capturedAt, 123);
	assert.equal(report.accountLabel, "debonzi");
	assert.equal(report.plan, "prolite");
	assert.equal(report.groups.length, 2);
	assert.equal(report.groups[0]?.id, "codex");
	assert.equal(report.groups[0]?.windows[0]?.usedPercent, 15);
	assert.equal(report.groups[0]?.windows[0]?.remainingPercent, 85);
	assert.equal(report.resetCredits?.available, 2);
	assert.equal(report.resetCredits?.usable, 0);
});

test("omits optional reset fields instead of assuming zero", () => {
	const report = normalizeCodexUsage({
		rate_limit: { primary_window: { used_percent: 25 } },
	});
	assert.equal(report.groups[0]?.windows[0]?.resetsAt, undefined);
	assert.equal(report.resetCredits, undefined);
});

test("rejects payloads without displayable usage", () => {
	assert.throws(() => normalizeCodexUsage({ plan_type: "pro" }), /no displayable usage data/u);
	assert.throws(() => normalizeCodexUsage([]), /not an object/u);
});

test("matches a model-specific group and orders it first", () => {
	const report = normalizeCodexUsage(payload);
	const selection = selectUsageGroups(report, sparkModel, true);
	assert.equal(selection.selectedGroupId, "codex_bengalfox");
	assert.deepEqual(
		selection.groups.map((group) => group.id),
		["codex_bengalfox", "codex"],
	);
});

test("uses the primary Codex limit when no model-specific group matches", () => {
	const report = normalizeCodexUsage(payload);
	const selection = selectUsageGroups(report, defaultModel, false);
	assert.equal(selection.selectedGroupId, "codex");
	assert.equal(selection.groups.length, 1);
});

test("formats compact status with local reset and usable reset credits", () => {
	const report = normalizeCodexUsage(payload);
	assert.equal(
		formatUsageStatusline(report, defaultModel, false),
		"codex 85% wk reset Aug 5 01:13 · resets 2 (0 usable)",
	);
	assert.equal(
		formatUsageStatusline(report, sparkModel, false),
		"codex spark 100% wk reset Aug 6 15:12 · resets 2 (0 usable)",
	);
	const allModels = formatUsageStatusline(report, sparkModel, true);
	assert.match(allModels, /^codex spark 100% wk reset Aug 6 15:12 \| codex 85%/u);
	assert.match(allModels, /resets 2 \(0 usable\)$/u);
});

test("formats a detailed report without opaque identifiers or full email", () => {
	const report = normalizeCodexUsage(payload);
	const output = formatUsageReport(report, defaultModel);
	assert.match(output, /Account: debonzi/u);
	assert.match(output, /Codex limit · selected:/u);
	assert.match(output, /Reset credits: 2 available · 0 usable/u);
	assert.doesNotMatch(output, /debonzi@example\.com|user-opaque/u);
});

test("extracts only a valid email local part", () => {
	assert.equal(emailLocalPart("debonzi@example.com"), "debonzi");
	assert.equal(emailLocalPart("opaque-id"), undefined);
	assert.equal(emailLocalPart(undefined), undefined);
});

test("formats reset timestamps in the process local timezone", () => {
	assert.equal(formatResetAt(GENERAL_RESET), "Aug 5 01:13");
});
