import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	formatResetAt,
	formatUsageReport,
	formatUsageStatusline,
	normalizeCopilotUsage,
	parseConfig,
} from "./core.ts";

const RESET = Date.UTC(2026, 7, 1, 0, 0) / 1000;

const model = {
	provider: "github-copilot",
	id: "gpt-5.4",
	name: "GPT-5.4",
};

test("uses defaults and validates the refresh interval", () => {
	assert.deepEqual(parseConfig(undefined), { config: DEFAULT_CONFIG, warnings: [] });
	assert.equal(parseConfig({ refreshIntervalMinutes: 1 }).config.refreshIntervalMinutes, 1);
	assert.equal(parseConfig({ refreshIntervalMinutes: 1440 }).config.refreshIntervalMinutes, 1440);
	const invalid = parseConfig({ refreshIntervalMinutes: 0 });
	assert.deepEqual(invalid.config, DEFAULT_CONFIG);
	assert.equal(invalid.warnings.length, 1);
});

test("normalizes legacy premium request quota", () => {
	const report = normalizeCopilotUsage(
		{
			login: "octocat",
			copilot_plan: "individual",
			quota_reset_date_utc: "2026-08-01T00:00:00Z",
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 245,
					token_based_billing: false,
					unlimited: false,
				},
			},
		},
		500,
	);

	assert.equal(report.capturedAt, 500);
	assert.equal(report.accountLabel, "octocat");
	assert.equal(report.plan, "individual");
	assert.deepEqual(report.quota, {
		id: "premium-requests",
		label: "Premium requests",
		used: 55,
		remaining: 245,
		limit: 300,
		unlimited: false,
		resetsAt: RESET,
	});
	assert.equal(formatUsageStatusline(report), "copilot 245/300 82%");
});

test("preserves AI Credits semantics and explicit usage", () => {
	const report = normalizeCopilotUsage({
		quota_reset_date_utc: "2026-08-01T00:00:00Z",
		quota_snapshots: {
			premium_interactions: {
				credits_used: 300,
				entitlement: 1_500,
				remaining: 1_200,
				token_based_billing: true,
				unlimited: false,
			},
		},
	});

	assert.deepEqual(report.quota, {
		id: "ai-credits",
		label: "AI credits",
		used: 300,
		remaining: 1_200,
		limit: 1_500,
		unlimited: false,
		resetsAt: RESET,
	});
	assert.equal(formatUsageStatusline(report), "copilot credits 1200/1500 80%");
	assert.match(formatUsageReport(report, model), /AI credits:.*1200 of 1500 left · 80%/u);
});

test("represents additional usage without rejecting a negative included balance", () => {
	const report = normalizeCopilotUsage({
		quota_snapshots: {
			premium_interactions: {
				entitlement: 1_500,
				overage_count: 100,
				remaining: -100,
				token_based_billing: true,
				unlimited: false,
			},
		},
	});

	assert.equal(report.quota.remaining, 0);
	assert.equal(report.quota.used, 1_600);
	assert.equal(report.additionalUsage, 100);
	assert.equal(formatUsageStatusline(report), "copilot credits 0/1500 0% +100 over");
	assert.match(formatUsageReport(report, model), /Additional usage: 100 AI credits/u);
});

test("normalizes the Copilot Free quota shape", () => {
	const report = normalizeCopilotUsage({
		access_type_sku: "free_limited_copilot",
		limited_user_quotas: { chat: 40, completions: 1_900 },
		limited_user_reset_date: "2026-08-01T00:00:00Z",
		monthly_quotas: { chat: 50, completions: 2_000 },
	});

	assert.deepEqual(report.quota, {
		id: "chat-requests",
		label: "Chat requests",
		used: 10,
		remaining: 40,
		limit: 50,
		unlimited: false,
		resetsAt: RESET,
	});
	assert.equal(formatUsageStatusline(report), "copilot chat 40/50 80%");
});

test("handles unlimited plans and the legacy quota_remaining field", () => {
	const unlimited = normalizeCopilotUsage({
		quota_snapshots: {
			premium_interactions: { token_based_billing: true, unlimited: true },
		},
	});
	assert.equal(formatUsageStatusline(unlimited), "copilot credits unlimited");

	const legacy = normalizeCopilotUsage({
		quota_snapshots: {
			premium_interactions: {
				entitlement: 300,
				quota_remaining: -20,
				unlimited: false,
			},
		},
	});
	assert.equal(legacy.additionalUsage, 20);
	assert.equal(formatUsageStatusline(legacy), "copilot 0/300 0% +20 over");
});

test("rejects malformed or incomplete responses", () => {
	assert.throws(() => normalizeCopilotUsage([]), /not an object/iu);
	assert.throws(() => normalizeCopilotUsage({}), /supported quota/iu);
	assert.throws(
		() =>
			normalizeCopilotUsage({
				quota_snapshots: { premium_interactions: { entitlement: 300 } },
			}),
		/incomplete/iu,
	);
});

test("sanitizes provider labels before display", () => {
	const report = normalizeCopilotUsage({
		login: "octo\u001b[31m\ncat",
		copilot_plan: "pro\u0007 plan",
		quota_snapshots: { premium_interactions: { unlimited: true } },
	});
	assert.equal(report.accountLabel, "octo cat");
	assert.equal(report.plan, "pro plan");
	assert.doesNotMatch(formatUsageReport(report, model), /\u001b|\u0007/u);
});

test("formats reset timestamps in the process local timezone", () => {
	assert.equal(formatResetAt(RESET), "Aug 1 00:00");
});
