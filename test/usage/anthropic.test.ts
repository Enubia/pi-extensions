import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, formatProgressBar, formatResetTime, formatTime, formatUsageText, normalizeProfilePayload, normalizeUsagePayload, resolveAnthropicOAuthToken, safeUsageError, styleUsageText } from "../../extensions/usage/anthropic.ts";

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);

const USAGE_PAYLOAD = {
	five_hour: { utilization: 11, resets_at: "2030-01-01T14:10:00Z", limit_dollars: null, used_dollars: null, remaining_dollars: null },
	seven_day: { utilization: 73, resets_at: "2030-01-08T06:00:00Z" },
	seven_day_opus: null,
	extra_usage: {
		is_enabled: true,
		monthly_limit: 2500,
		used_credits: 675,
		utilization: 27,
		currency: "CAD",
		decimal_places: 2,
		disabled_reason: null,
		user_disabled: false,
		spend_limit_reached: false,
	},
	limits: [
		{ kind: "session", group: "session", percent: 11, severity: "normal", resets_at: "2030-01-01T14:10:00Z", scope: null, is_active: true },
		{ kind: "weekly_all", group: "weekly", percent: 73, severity: "warning", resets_at: "2030-01-08T06:00:00Z", scope: null, is_active: false },
		{ kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Synthetic Model" } }, is_active: false },
	],
	spend: {
		used: { amount_minor: 675, currency: "CAD", exponent: 2 },
		limit: { amount_minor: 2500, currency: "CAD", exponent: 2 },
		percent: 27,
		severity: "normal",
		enabled: true,
		disabled_reason: null,
		cap: { money: { amount_minor: 2500, currency: "CAD", exponent: 2 }, credits: null },
		balance: null,
	},
};

test("resolves the Anthropic OAuth access token through the current model registry", async () => {
	const model = { provider: "anthropic" };
	const registry = {
		getAll: () => [{ provider: "openai-codex" }, model],
		isUsingOAuth: (candidate: unknown) => candidate === model,
		getApiKeyForProvider: async (provider: string) => provider === "anthropic" ? "sk-ant-oat-test" : undefined,
	};

	assert.equal(await resolveAnthropicOAuthToken(registry), "sk-ant-oat-test");
	assert.equal(await resolveAnthropicOAuthToken({ ...registry, isUsingOAuth: () => false }), undefined);
	assert.equal(await resolveAnthropicOAuthToken({ ...registry, getAll: () => [] }), undefined);
	assert.equal(await resolveAnthropicOAuthToken({ ...registry, getApiKeyForProvider: async () => undefined }), undefined);
});

test("normalizes rate limit windows, scoped weekly limits, and extra usage spend", () => {
	const usage = normalizeUsagePayload(USAGE_PAYLOAD, NOW);
	assert.ok(usage);
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(usage.windows.map((window) => window.id), ["five_hour", "seven_day", "weekly_scoped:Synthetic Model"]);

	const [session, weekly, scoped] = usage.windows;
	assert.deepEqual(session, {
		id: "five_hour",
		label: "5-hour session",
		usedPercent: 11,
		remainingPercent: 89,
		resetsAt: Date.parse("2030-01-01T14:10:00Z"),
		severity: "normal",
		active: true,
	});
	assert.equal(weekly.label, "7-day all models");
	assert.equal(weekly.severity, "warning");
	assert.equal(weekly.usedPercent, 73);
	assert.equal(scoped.label, "7-day Synthetic Model");
	assert.equal(scoped.resetsAt, undefined);

	assert.deepEqual(usage.spend, {
		enabled: true,
		used: { amountMinor: 675, currency: "CAD", exponent: 2 },
		limit: { amountMinor: 2500, currency: "CAD", exponent: 2 },
		cap: { amountMinor: 2500, currency: "CAD", exponent: 2 },
		usedPercent: 27,
		limitReached: false,
		userDisabled: false,
		severity: "normal",
	});
});

test("falls back to legacy extra usage fields and dollar windows when the spend block is absent", () => {
	const usage = normalizeUsagePayload({
		five_hour: { utilization: 100, resets_at: "2030-01-01T13:00:00Z", limit_dollars: 25, used_dollars: 25, remaining_dollars: 0 },
		extra_usage: { is_enabled: true, monthly_limit: 2500, used_credits: 2500, utilization: 100, currency: "GBP", decimal_places: 2, spend_limit_reached: true },
	}, NOW);

	assert.ok(usage);
	assert.deepEqual(usage.windows[0].limit, { amountMinor: 2500, currency: "GBP", exponent: 2 });
	assert.deepEqual(usage.windows[0].used, { amountMinor: 2500, currency: "GBP", exponent: 2 });
	assert.equal(usage.spend?.limitReached, true);
	assert.deepEqual(usage.spend?.limit, { amountMinor: 2500, currency: "GBP", exponent: 2 });
});

test("rejects payloads without any recognizable usage data", () => {
	assert.equal(normalizeUsagePayload(undefined), undefined);
	assert.equal(normalizeUsagePayload("nope"), undefined);
	assert.equal(normalizeUsagePayload([]), undefined);
	assert.equal(normalizeUsagePayload({ unrelated: true }), undefined);
});

test("normalizes the organization profile into account context", () => {
	assert.deepEqual(normalizeProfilePayload({
		account: { email: "member-alpha@example.invalid", has_claude_max: false, has_claude_pro: false },
		organization: {
			name: "Synthetic Example Workspace",
			organization_type: "synthetic_team",
			rate_limit_tier: "default_synthetic_plan_2x",
			seat_tier: "synthetic_seat_2",
			has_extra_usage_enabled: true,
		},
	}), {
		email: "member-alpha@example.invalid",
		organization: "Synthetic Example Workspace",
		organizationType: "Synthetic Team",
		plan: "Synthetic Plan 2x",
		seat: "Synthetic Seat 2",
		extraUsageEnabled: true,
	});

	assert.deepEqual(normalizeProfilePayload({ account: { has_claude_pro: true } }), { plan: "Claude Pro" });
	assert.equal(normalizeProfilePayload(undefined), undefined);
	assert.equal(normalizeProfilePayload({}), undefined);
});

test("formats money with currency and minor unit precision", () => {
	assert.equal(formatMoney({ amountMinor: 2500, currency: "GBP", exponent: 2 }, "en-US"), "£25.00");
	assert.equal(formatMoney({ amountMinor: 675, currency: "CAD", exponent: 2 }, "en-US"), "CA$6.75");
	assert.equal(formatMoney({ amountMinor: 1, currency: "ZZ", exponent: 2 }, "en-US"), "0.01 ZZ");
	assert.equal(formatMoney(undefined), undefined);
});

test("renders progress bars only for valid percentages", () => {
	assert.equal(formatProgressBar(0, 8), "────────");
	assert.equal(formatProgressBar(1, 8), "█───────");
	assert.equal(formatProgressBar(100, 8), "████████");
	assert.equal(formatProgressBar(undefined), undefined);
	assert.equal(formatProgressBar(101), undefined);
	assert.equal(formatProgressBar(-1), undefined);
});

test("formats reset times relative and absolute", () => {
	assert.equal(formatResetTime(undefined), "unknown");
	assert.equal(formatTime(undefined), "unknown");
	assert.equal(formatTime(NOW, "en-US", "UTC"), "Jan 1, 12:00 PM");
	assert.match(formatResetTime(NOW + 90 * 60 * 1000, NOW, "en-US", "UTC"), /^in 2h · Jan 1, 1:30 PM$/);
	assert.match(formatResetTime(NOW - 30 * 1000, NOW, "en-US", "UTC"), /^30s ago · Jan 1, 11:59 AM$/);
});

test("formats a complete usage report with limits and extra usage spend", () => {
	const usage = normalizeUsagePayload(USAGE_PAYLOAD, NOW);
	assert.ok(usage);
	const content = formatUsageText({ ...usage, account: { plan: "Synthetic Plan 2x", organization: "Synthetic Example Workspace" } }, NOW, "en-US", "UTC");

	assert.equal(content.split("\n")[0], "◆ Claude subscription usage · Synthetic Plan 2x · Synthetic Example Workspace");
	assert.match(content, /◇ Rate limits/);
	assert.match(content, /5-hour session\s+█+─+\s+11% used · 89% remaining/);
	assert.match(content, /resets in 3h · Jan 1, 2:10 PM · active window/);
	assert.match(content, /7-day all models\s+█+─+\s+73% used · 27% remaining/);
	assert.match(content, /severity warning/);
	assert.match(content, /◇ Extra usage \(over-plan spend\)/);
	assert.match(content, /CA\$6\.75 of CA\$25\.00 used · 27% · enabled/);
	assert.match(content, /monthly cap CA\$25\.00/);
	assert.match(content, /^Fetched Jan 1, 12:00 PM$/m);
});

test("reports missing windows and spend without inventing values", () => {
	const content = formatUsageText({ fetchedAt: NOW, windows: [] }, NOW, "en-US", "UTC");
	assert.match(content, /Usage windows unknown/);
	assert.match(content, /Not reported for this account/);
});

test("flags an enabled extra usage allowance that has no configured monthly limit", () => {
	const usage = normalizeUsagePayload({
		five_hour: { utilization: 9, resets_at: "2030-01-01T16:00:00Z" },
		extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 0, utilization: null, currency: "CAD", decimal_places: 2, spend_limit_reached: false },
	}, NOW);
	assert.ok(usage);
	const content = formatUsageText(usage, NOW, "en-US", "UTC");
	assert.match(content, /CA\$0\.00 of CA\$0\.00 used · enabled/);
	assert.match(content, /no monthly limit configured for this member/);
});

test("marks a reached spend limit and flags high utilization", () => {
	const usage = normalizeUsagePayload({
		five_hour: { utilization: 94, resets_at: "2030-01-01T13:00:00Z" },
		extra_usage: { is_enabled: true, monthly_limit: 2500, used_credits: 2500, utilization: 100, currency: "GBP", decimal_places: 2, spend_limit_reached: true },
	}, NOW);
	assert.ok(usage);
	const content = formatUsageText(usage, NOW, "en-US", "UTC");
	assert.match(content, /⚠ Extra usage spend limit reached/);
	assert.match(content, /spend limit reached/);

	const styled = styleUsageText(content, {
		title: (value) => `T(${value})`,
		section: (value) => `S(${value})`,
		muted: (value) => `M(${value})`,
		success: (value) => `G(${value})`,
		warning: (value) => `W(${value})`,
		error: (value) => `E(${value})`,
	});
	assert.match(styled, /^T\(◆ Claude subscription usage\)$/m);
	assert.match(styled, /^S\(◇ Rate limits\)$/m);
	assert.match(styled, /E\(█+─*\)/);
	assert.match(styled, /^E\( {2}⚠ Extra usage spend limit reached/m);
});

test("styles moderate and low utilization bars distinctly", () => {
	const styles = {
		title: (value: string) => value,
		section: (value: string) => value,
		muted: (value: string) => value,
		success: (value: string) => `G(${value})`,
		warning: (value: string) => `W(${value})`,
		error: (value: string) => `E(${value})`,
	};
	assert.match(styleUsageText("◆ x\nmuted\n  a  ████────────  78% used", styles), /W\(████────────\)/);
	assert.match(styleUsageText("◆ x\nmuted\n  a  █───────────  8% used", styles), /G\(█───────────\)/);
});

test("explains every usage failure without leaking token details", () => {
	assert.match(safeUsageError({ code: "not-authenticated" }), /pi \/login/);
	assert.match(safeUsageError({ code: "unauthorized" }), /could not be authorized/);
	assert.match(safeUsageError({ code: "timeout" }), /timed out/);
	assert.match(safeUsageError({ code: "backend" }), /unavailable/);
	assert.match(safeUsageError(new Error("Bearer sk-ant-oat-secret")), /unavailable/);
});
