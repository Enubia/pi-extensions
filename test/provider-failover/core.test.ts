import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../extensions/subagent-models/core.ts";
import { classifyFailure, type FailoverState, formatDuration, formatState, isCoolingDown, parseResetAt, parseState, planFailover, planRestore, pruneCooldowns, withCooldown } from "../../extensions/provider-failover/core.ts";

const config = parseConfig({
	fallbackProfile: "anthropic",
	roles: {},
	profiles: {
		anthropic: {
			providers: ["anthropic"],
			defaultTier: "cheap",
			tiers: {
				cheap: { model: "anthropic/claude-haiku-4-5", thinking: "high" },
				standard: { model: "anthropic/claude-sonnet-5", thinking: "high" },
				capable: { model: "anthropic/claude-opus-5", thinking: "xhigh" },
			},
		},
		"openai-codex": {
			providers: ["openai-codex", "openai"],
			defaultTier: "cheap",
			tiers: {
				cheap: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
				standard: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
			},
		},
	},
});

const NOW = 1_800_000_000_000;
const empty: FailoverState = { cooldowns: {} };
const usable = () => true;

test("failures are classified by status first, then message", () => {
	assert.equal(classifyFailure({ status: 429 }), "quota");
	assert.equal(classifyFailure({ status: 529 }), "transient");
	assert.equal(classifyFailure({ status: 503 }), "transient");
	assert.equal(classifyFailure({ status: 404 }), "unavailable");
	assert.equal(classifyFailure({ status: 403, message: "insufficient_quota" }), "quota");
	assert.equal(classifyFailure({ status: 403, message: "forbidden" }), "ignore");
	assert.equal(classifyFailure({ message: "You have reached your usage limit" }), "quota");
	assert.equal(classifyFailure({ message: "Overloaded" }), "transient");
	assert.equal(classifyFailure({ message: "model is not available" }), "unavailable");
	assert.equal(classifyFailure({ message: "Request was aborted" }), "ignore");
	assert.equal(classifyFailure({ status: 429, message: "prompt is too long" }), "ignore");
	assert.equal(classifyFailure({ message: "something odd" }), "ignore");
});

test("reset headers are read as seconds, unix time, durations, or dates", () => {
	assert.equal(parseResetAt({ "retry-after": "60" }, NOW), NOW + 60_000);
	assert.equal(parseResetAt({ "anthropic-ratelimit-unified-reset": String(Math.floor(NOW / 1000) + 3600) }, NOW), (Math.floor(NOW / 1000) + 3600) * 1000);
	assert.equal(parseResetAt({ "x-ratelimit-reset-requests": "6m30s" }, NOW), NOW + 390_000);
	assert.equal(parseResetAt({ "Retry-After": new Date(NOW + 120_000).toUTCString() }, NOW), Math.floor((NOW + 120_000) / 1000) * 1000);
	assert.equal(parseResetAt({ "retry-after": "0" }, NOW), undefined);
	assert.equal(parseResetAt({ "x-other": "60" }, NOW), undefined);
	assert.equal(parseResetAt(undefined, NOW), undefined);
});

test("failover jumps to the same tier in the next profile", () => {
	const target = planFailover(config, { provider: "anthropic", id: "claude-sonnet-5" }, { now: NOW, state: empty, isUsable: usable });
	assert.deepEqual(target, { provider: "openai-codex", id: "gpt-5.6-terra", tier: "standard", profile: "openai-codex", downgraded: false, thinking: "high" });
});

test("a tier missing in the target profile falls back to the nearest cheaper tier", () => {
	const target = planFailover(config, { provider: "anthropic", id: "claude-opus-5" }, { now: NOW, state: empty, isUsable: usable });
	assert.equal(target?.id, "gpt-5.6-terra");
	assert.equal(target?.tier, "standard");
	assert.equal(target?.downgraded, true);
});

test("failover wraps back to the first profile from the last", () => {
	const target = planFailover(config, { provider: "openai-codex", id: "gpt-5.6-luna" }, { now: NOW, state: empty, isUsable: usable });
	assert.equal(target?.provider, "anthropic");
	assert.equal(target?.id, "claude-haiku-4-5");
});

test("cooling-down providers and unauthenticated models are skipped", () => {
	const cooling = withCooldown(empty, "openai-codex", { until: NOW + 60_000, kind: "quota", reason: "" });
	assert.equal(planFailover(config, { provider: "anthropic", id: "claude-sonnet-5" }, { now: NOW, state: cooling, isUsable: usable }), undefined);
	assert.equal(planFailover(config, { provider: "anthropic", id: "claude-sonnet-5" }, { now: NOW + 61_000, state: cooling, isUsable: usable })?.provider, "openai-codex");
	assert.equal(planFailover(config, { provider: "anthropic", id: "claude-sonnet-5" }, { now: NOW, state: empty, isUsable: () => false }), undefined);
});

test("a model outside every profile still fails over via the fallback profile's default tier", () => {
	const target = planFailover(config, { provider: "google", id: "gemini-4" }, { now: NOW, state: empty, isUsable: usable });
	assert.equal(target?.id, "claude-haiku-4-5");
});

test("restore waits for the origin provider's cooldown", () => {
	const state: FailoverState = { cooldowns: { anthropic: { until: NOW + 60_000, kind: "quota", reason: "" } }, origin: { provider: "anthropic", id: "claude-sonnet-5", thinking: "high" } };
	const current = { provider: "openai-codex", id: "gpt-5.6-terra" };
	assert.equal(planRestore(state, current, NOW), undefined);
	assert.deepEqual(planRestore(state, current, NOW + 61_000), { provider: "anthropic", id: "claude-sonnet-5", thinking: "high" });
	assert.equal(planRestore(state, { provider: "anthropic", id: "claude-sonnet-5" }, NOW + 61_000), undefined);
	assert.equal(planRestore(empty, current, NOW), undefined);
});

test("state round-trips and prunes expired cooldowns", () => {
	const state: FailoverState = {
		cooldowns: { anthropic: { until: NOW + 1000, kind: "quota", reason: "limit" }, "openai-codex": { until: NOW - 1000, kind: "transient", reason: "" } },
		origin: { provider: "anthropic", id: "claude-sonnet-5", thinking: "high" },
	};
	const pruned = pruneCooldowns(state, NOW);
	assert.deepEqual(Object.keys(pruned.cooldowns), ["anthropic"]);
	assert.deepEqual(parseState(JSON.parse(JSON.stringify(pruned))), pruned);
	assert.deepEqual(parseState("nonsense"), empty);
	assert.deepEqual(parseState({ cooldowns: { x: { kind: "quota" } } }), empty);
	assert.equal(isCoolingDown(state, "anthropic", NOW), true);
	assert.equal(isCoolingDown(state, "openai-codex", NOW), false);
});

test("durations and state render for humans", () => {
	assert.equal(formatDuration(0), "now");
	assert.equal(formatDuration(45_000), "1m");
	assert.equal(formatDuration(90 * 60_000), "1h30m");
	assert.equal(formatDuration(120 * 60_000), "2h");
	const lines = formatState({ cooldowns: { anthropic: { until: NOW + 3_600_000, kind: "quota", reason: "usage limit" } }, origin: { provider: "anthropic", id: "claude-sonnet-5" } }, { provider: "openai-codex", id: "gpt-5.6-terra" }, NOW);
	assert.match(lines.join("\n"), /Active: openai-codex\/gpt-5\.6-terra/);
	assert.match(lines.join("\n"), /Cooldown: anthropic for 1h \(quota: usage limit\)/);
	assert.match(formatState(empty, { provider: "anthropic", id: "x" }, NOW).join("\n"), /Cooldowns: none/);
});
