import assert from "node:assert/strict";
import test from "node:test";
import { formatProgressBar, formatResetTime, formatUsageText, normalizeUsagePayload, resolveCodexOAuthAuth, safeUsageError, styleUsageText } from "../../extensions/usage/openai.ts";

test("resolves refreshed Codex OAuth authentication through the current model registry", async () => {
	const jwt = (claim: unknown) => `header.${Buffer.from(JSON.stringify(claim)).toString("base64url")}.signature`;
	const model = { provider: "openai-codex" };
	const registry = {
		getAll: () => [model],
		isUsingOAuth: (candidate: unknown) => candidate === model,
		getApiKeyForProvider: async (_provider: string) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account-primary" } }),
	};

	assert.deepEqual(await resolveCodexOAuthAuth(registry), {
		accessToken: await registry.getApiKeyForProvider("openai-codex"),
		accountId: "synthetic-account-primary",
	});
	assert.equal(await resolveCodexOAuthAuth({ ...registry, isUsingOAuth: () => false }), undefined);
	assert.equal(await resolveCodexOAuthAuth({ ...registry, getAll: () => [] }), undefined);
	assert.equal(await resolveCodexOAuthAuth({ ...registry, getApiKeyForProvider: async () => undefined }), undefined);
	assert.equal(await resolveCodexOAuthAuth({ ...registry, getApiKeyForProvider: async () => "not-a-jwt" }), undefined);
	assert.equal(await resolveCodexOAuthAuth({ ...registry, getApiKeyForProvider: async () => jwt({}) }), undefined);
	assert.equal(await resolveCodexOAuthAuth({ ...registry, getApiKeyForProvider: async () => jwt({ "https://api.openai.com/auth": {} }) }), undefined);
});

test("normalizes every Codex quota bucket and optional account controls", () => {
	const usage = normalizeUsagePayload({
		plan_type: "synthetic_standard",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 37,
				limit_window_seconds: 3600,
				reset_at: 1893456120,
			},
			secondary_window: {
				used_percent: 8,
				limit_window_seconds: 86400,
				reset_at: 1893459600,
			},
		},
		credits: { has_credits: true, unlimited: false, balance: "6.25" },
		rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" },
		spend_control: {
			reached: false,
			individual_limit: {
				limit: "40000",
				used: "12000",
				remaining_percent: 70,
				reset_at: 1893459600,
			},
		},
		additional_rate_limits: [{
			limit_name: "Synthetic Feature",
			metered_feature: "synthetic_feature",
			rate_limit: {
				primary_window: {
					used_percent: 91,
					limit_window_seconds: 1800,
					reset_at: 1893459600,
				},
			},
		}],
	}, 1_893_456_000_000);

	assert.deepEqual(usage, {
		planType: "synthetic_standard",
		fetchedAt: 1_893_456_000_000,
		buckets: [
			{
				id: "codex",
				allowed: true,
				limitReached: false,
				windows: [
					{ name: "Primary", usedPercent: 37, remainingPercent: 63, durationMinutes: 60, resetsAt: 1893456120 },
					{ name: "Secondary", usedPercent: 8, remainingPercent: 92, durationMinutes: 1440, resetsAt: 1893459600 },
				],
				credits: { hasCredits: true, unlimited: false, balance: "6.25" },
				spendControl: { reached: false, limit: "40000", used: "12000", remainingPercent: 70, resetsAt: 1893459600 },
				reachedType: "workspace_member_usage_limit_reached",
			},
			{
				id: "synthetic_feature",
				name: "Synthetic Feature",
				windows: [
					{ name: "Primary", usedPercent: 91, remainingPercent: 9, durationMinutes: 30, resetsAt: 1893459600 },
				],
			},
		],
	});
});

test("keeps missing window values unknown and ignores malformed fields", () => {
	const usage = normalizeUsagePayload({
		plan_type: "synthetic_basic",
		rate_limit: {
			primary_window: {
				used_percent: "37",
				limit_window_seconds: -1,
				reset_at: null,
			},
		},
		additional_rate_limits: [null, { metered_feature: "valid", rate_limit: { primary_window: {} } }],
	}, 123);

	assert.deepEqual(usage, {
		planType: "synthetic_basic",
		fetchedAt: 123,
		buckets: [
			{ id: "codex", windows: [{ name: "Primary" }] },
			{ id: "valid", windows: [{ name: "Primary" }] },
		],
	});
	assert.equal(normalizeUsagePayload(null), undefined);
	assert.equal(normalizeUsagePayload({ unexpected: true }), undefined);
	assert.equal(normalizeUsagePayload({ additional_rate_limits: [{}] }), undefined);
	assert.deepEqual(normalizeUsagePayload({
		additional_rate_limits: [
			{},
			{ metered_feature: "known", rate_limit: null },
		],
	}, 124), {
		fetchedAt: 124,
		buckets: [{ id: "known", windows: [] }],
	});
});

test("rejects percentages outside their documented range instead of guessing", () => {
	const usage = normalizeUsagePayload({ rate_limit: { primary_window: { used_percent: 140 } } }, 456);
	assert.deepEqual(usage, {
		fetchedAt: 456,
		buckets: [{ id: "codex", windows: [{ name: "Primary" }] }],
	});
});

test("formats bounded quota progress bars without treating unknown usage as zero", () => {
	assert.equal(formatProgressBar(0, 10), "──────────");
	assert.equal(formatProgressBar(1, 10), "█─────────");
	assert.equal(formatProgressBar(37, 10), "████──────");
	assert.equal(formatProgressBar(100, 10), "██████████");
	assert.equal(formatProgressBar(undefined, 10), undefined);
});

test("formats reset timestamps with relative and local absolute time", () => {
	assert.equal(
		formatResetTime(1893456120, 1_893_456_000_000, "en-US", "UTC"),
		"in 2m · Jan 1, 2030, 12:02 AM",
	);
	assert.equal(formatResetTime(undefined, 1_893_456_000_000, "en-US", "UTC"), "unknown");
	assert.equal(formatResetTime(Number.MAX_VALUE, 1_893_456_000_000, "en-US", "UTC"), "unknown");
});

test("renders every bucket with unknowns, credits, and spend controls clearly labeled", () => {
	const text = formatUsageText({
		planType: "synthetic_standard",
		fetchedAt: 1_893_456_000_000,
		buckets: [
			{
				id: "codex",
				windows: [
					{ name: "Primary", usedPercent: 37, remainingPercent: 63, durationMinutes: 60, resetsAt: 1893456120 },
					{ name: "Secondary" },
				],
				credits: { hasCredits: true, unlimited: false, balance: "6.25" },
				spendControl: { reached: false, limit: "40000", used: "12000", remainingPercent: 70, resetsAt: 1893459600 },
			},
			{
				id: "synthetic_feature",
				name: "Synthetic Feature",
				windows: [{ name: "Primary", usedPercent: 91, remainingPercent: 9, durationMinutes: 30 }],
			},
		],
	}, 1_893_456_000_000, "en-US", "UTC");

	assert.match(text, /Codex subscription quota · Synthetic standard plan/);
	assert.match(text, /Not OpenAI API billing or general ChatGPT limits/);
	assert.match(text, /Codex\n  Primary  ██████──────────  37% used · 63% remaining\n           1-hour window · resets in 2m · Jan 1, 2030, 12:02 AM/);
	assert.match(text, /Secondary\n           Usage unknown · window and reset unknown/);
	assert.match(text, /Credits  6\.25/);
	assert.match(text, /Spend control  12000 of 40000 used · 70% remaining/);
	assert.doesNotMatch(text, /Requests: allowed/);
	assert.doesNotMatch(text, /Limit: available/);
	assert.match(text, /Synthetic Feature\n  Primary  ███████████████─  91% used · 9% remaining\n           30-minute window · reset unknown/);
	assert.doesNotMatch(text, /synthetic_feature/);
});

test("keeps low-usage weekly buckets compact and omits empty normal-state details", () => {
	const reset = Date.UTC(2030, 0, 8, 0, 0) / 1000;
	const text = formatUsageText({
		planType: "synthetic_standard",
		fetchedAt: Date.UTC(2030, 0, 1, 0, 0),
		buckets: [{
			id: "synthetic_weekly_feature",
			name: "Synthetic-Codex-Weekly",
			allowed: true,
			limitReached: false,
			windows: [{ name: "Primary", usedPercent: 1, remainingPercent: 99, durationMinutes: 10080, resetsAt: reset }],
			spendControl: { reached: false },
		}],
	}, Date.UTC(2030, 0, 1, 0, 0), "en-US", "UTC");

	assert.match(text, /Synthetic Codex Weekly/);
	assert.match(text, /Primary  █───────────────  1% used · 99% remaining/);
	assert.match(text, /7-day window · resets in 7d · Jan 8, 2030, 12:00 AM/);
	assert.doesNotMatch(text, /synthetic_weekly_feature|Requests|Limit:|Spend control|amount unknown/);
});

test("styles headings, details, and utilization bars by severity", () => {
	const styled = styleUsageText([
		"◆ Codex subscription quota · Synthetic Standard plan",
		"Not OpenAI API billing or general ChatGPT limits.",
		"",
		"◇ Codex",
		"  Primary  ██████──────────  37% used · 63% remaining",
		"           1-hour window · resets in 2m",
		"  ⚠ Limit reached · requests blocked",
	].join("\n"), {
		title: (value) => `<title>${value}</title>`,
		section: (value) => `<section>${value}</section>`,
		muted: (value) => `<muted>${value}</muted>`,
		success: (value) => `<success>${value}</success>`,
		warning: (value) => `<warning>${value}</warning>`,
		error: (value) => `<error>${value}</error>`,
	});

	assert.match(styled, /<title>◆ Codex subscription quota · Synthetic Standard plan<\/title>/);
	assert.match(styled, /<muted>Not OpenAI API billing or general ChatGPT limits\.<\/muted>/);
	assert.match(styled, /<section>◇ Codex<\/section>/);
	assert.match(styled, /<success>██████──────────<\/success>  37% used/);
	assert.match(styled, /<muted>           1-hour window · resets in 2m<\/muted>/);
	assert.match(styled, /<error>  ⚠ Limit reached · requests blocked<\/error>/);
});

test("turns arbitrary failures into fixed secret-safe messages", () => {
	const sensitive = new Error("Bearer private-access-value account private-account-value");
	const message = safeUsageError(sensitive);
	assert.equal(message, "Codex subscription usage is unavailable. Open the official dashboard or try again.");
	assert.equal(message.includes("private-access-value"), false);
	assert.equal(message.includes("private-account-value"), false);
	assert.equal(safeUsageError({ code: "not-authenticated" }), "Sign in to ChatGPT Plus/Pro with pi /login to view Codex subscription usage.");
	assert.equal(safeUsageError({ code: "unauthorized" }), "The Codex subscription session could not be authorized. Run pi /login and try again.");
	assert.equal(safeUsageError({ code: "timeout" }), "Codex subscription usage timed out. Try again or open the official dashboard.");
});
