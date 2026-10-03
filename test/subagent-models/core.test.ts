import assert from "node:assert/strict";
import test from "node:test";
import {
	type Config,
	findTier,
	formatProfileSummary,
	formatRoleLine,
	formatTierLine,
	parseConfig,
	parseTierToken,
	patchDefaultTier,
	patchRole,
	patchTier,
	resolveProfileName,
	resolveSpawnModel,
	splitModelRef,
	thinkingWarnings,
} from "../../extensions/subagent-models/core.ts";

const RAW = {
	fallbackProfile: "anthropic",
	roles: {
		scout: "cheap",
		worker: { tier: "standard", thinking: "medium" },
		reviewer: "capable",
	},
	profiles: {
		anthropic: {
			providers: ["anthropic"],
			defaultTier: "cheap",
			tiers: {
				cheap: { model: "anthropic/claude-haiku-4-5", thinking: "high" },
				standard: { model: "anthropic/claude-sonnet-5", thinking: "high" },
				capable: { model: "anthropic/claude-opus-5", thinking: "xhigh" },
				frontier: { model: "anthropic/claude-fable-5-1", thinking: "xhigh" },
			},
		},
		"openai-codex": {
			providers: ["openai-codex", "openai"],
			defaultTier: "cheap",
			tiers: {
				cheap: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
				standard: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
				capable: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
				frontier: { model: "openai-codex/gpt-6-astra", thinking: "xhigh" },
			},
		},
	},
};

const config: Config = parseConfig(RAW);

test("config parsing accepts shorthand and object roles", () => {
	assert.deepEqual(config.roles.scout, { tier: "cheap" });
	assert.deepEqual(config.roles.worker, { tier: "standard", thinking: "medium" });
	assert.equal(config.profiles.anthropic.providers[0], "anthropic");
});

test("config parsing rejects broken input", () => {
	assert.throws(() => parseConfig({ profiles: {} }), /no profiles/);
	assert.throws(() => parseConfig({ ...RAW, fallbackProfile: "nope" }), /fallbackProfile/);
	assert.throws(() => parseConfig({ ...RAW, roles: { x: "genius" } }), /unknown tier/);
	assert.throws(() => parseConfig({ ...RAW, roles: { x: { tier: "cheap", thinking: "ultra" } } }), /unknown thinking level/);
	assert.throws(() => parseConfig({ ...RAW, profiles: { p: { providers: [], tiers: {} } } }), /non-empty providers/);
});

test("profile resolution follows the session provider, then the pin, then the fallback", () => {
	assert.deepEqual(resolveProfileName(config, { provider: "openai-codex" }), { name: "openai-codex", source: "provider" });
	assert.deepEqual(resolveProfileName(config, { provider: "openai" }), { name: "openai-codex", source: "provider" });
	assert.deepEqual(resolveProfileName(config, { provider: "openai-codex", pinned: "anthropic" }), { name: "anthropic", source: "pinned" });
	assert.deepEqual(resolveProfileName(config, { provider: "google" }), { name: "anthropic", source: "fallback" });
	assert.deepEqual(resolveProfileName(config, { provider: "google", pinned: "ghost" }), { name: "anthropic", source: "fallback" });
});

test("model refs split off a thinking suffix", () => {
	assert.deepEqual(splitModelRef("anthropic/claude-opus-5:high"), { id: "anthropic/claude-opus-5", thinking: "high" });
	assert.deepEqual(splitModelRef(" anthropic/claude-opus-5 "), { id: "anthropic/claude-opus-5" });
});

test("equal model IDs on different providers still remap, while identical qualified models ignore thinking-only differences", () => {
	const shared = parseConfig({
		fallbackProfile: "target",
		profiles: {
			target: { providers: ["openai-codex"], tiers: { standard: { model: "openai-codex/shared-model", thinking: "high" } } },
		},
	});
	for (const requestedModel of ["openai/shared-model:low", "shared-model:low"]) {
		assert.deepEqual(resolveSpawnModel(shared, { profileName: "target", requestedModel }), {
			action: "set", model: "openai-codex/shared-model:high", tier: "standard", source: "requested-model", previous: requestedModel,
		});
	}
	assert.deepEqual(resolveSpawnModel(shared, { profileName: "target", requestedModel: "openai-codex/shared-model:low" }), {
		action: "skip", reason: "already openai-codex/shared-model",
	});
	const bare = parseConfig({ fallbackProfile: "target", profiles: { target: { providers: ["openai"], tiers: { standard: { model: "shared-model", thinking: "high" } } } } });
	assert.deepEqual(resolveSpawnModel(bare, { profileName: "target", requestedModel: "shared-model:low" }), { action: "skip", reason: "already shared-model" });
	assert.deepEqual(resolveSpawnModel(shared, { profileName: "target", agentModel: "openai/shared-model", agentThinking: "medium" }), {
		action: "set", model: "openai-codex/shared-model", tier: "standard", source: "agent-model", previous: "openai/shared-model",
	});
});

test("reverse lookup finds the tier of any configured model, with or without provider", () => {
	assert.deepEqual(findTier(config, "anthropic/claude-opus-5"), { profile: "anthropic", tier: "capable" });
	assert.deepEqual(findTier(config, "claude-sonnet-5"), { profile: "anthropic", tier: "standard" });
	assert.deepEqual(findTier(config, "openai-codex/gpt-5.6-luna:high"), { profile: "openai-codex", tier: "cheap" });
	assert.equal(findTier(config, "google/gemini-4"), undefined);
});

test("tier tokens are recognised", () => {
	assert.equal(parseTierToken("standard"), "standard");
	assert.equal(parseTierToken("tier:capable"), "capable");
	assert.equal(parseTierToken("tier/cheap"), "cheap");
	assert.equal(parseTierToken("anthropic/claude-opus-5"), undefined);
	assert.equal(parseTierToken(undefined), undefined);
});

test("an agent's frontmatter model is remapped to the active profile at the same tier", () => {
	const resolution = resolveSpawnModel(config, { profileName: "openai-codex", agent: "visual-tester", agentModel: "anthropic/claude-sonnet-5" });
	assert.deepEqual(resolution, {
		action: "set",
		model: "openai-codex/gpt-5.6-terra:high",
		tier: "standard",
		source: "agent-model",
		previous: "anthropic/claude-sonnet-5",
	});
});

test("a mapped role beats the agent's frontmatter model", () => {
	const resolution = resolveSpawnModel(config, { profileName: "anthropic", agent: "scout", agentModel: "anthropic/claude-sonnet-5" });
	assert.equal(resolution.action, "set");
	assert.equal(resolution.action === "set" && resolution.model, "anthropic/claude-haiku-4-5:high");
	assert.equal(resolution.action === "set" && resolution.source, "role");
});

test("role thinking overrides the tier's thinking level", () => {
	const resolution = resolveSpawnModel(config, { profileName: "openai-codex", agent: "worker" });
	assert.equal(resolution.action === "set" && resolution.model, "openai-codex/gpt-5.6-terra:medium");
});

test("frontmatter thinking wins, so no thinking suffix is appended", () => {
	const resolution = resolveSpawnModel(config, { profileName: "openai-codex", agent: "reviewer", agentModel: "anthropic/claude-opus-5", agentThinking: "medium" });
	assert.equal(resolution.action === "set" && resolution.model, "openai-codex/gpt-5.6-sol");
});

test("an explicit tier token from the caller wins over the role", () => {
	const resolution = resolveSpawnModel(config, { profileName: "anthropic", agent: "scout", requestedModel: "capable" });
	assert.equal(resolution.action === "set" && resolution.model, "anthropic/claude-opus-5:xhigh");
	assert.equal(resolution.action === "set" && resolution.source, "explicit-tier");
});

test("an explicit cross-provider model is remapped at its own tier", () => {
	const resolution = resolveSpawnModel(config, { profileName: "openai-codex", agent: "scout", requestedModel: "anthropic/claude-opus-5" });
	assert.equal(resolution.action === "set" && resolution.model, "openai-codex/gpt-5.6-sol:xhigh");
	assert.equal(resolution.action === "set" && resolution.source, "requested-model");
});

test("nothing is touched when it should not be", () => {
	assert.deepEqual(resolveSpawnModel(config, { profileName: "anthropic", agent: "claude-code", agentModel: "fable", agentCli: "claude" }), {
		action: "skip",
		reason: "agent runs the claude CLI",
	});
	assert.deepEqual(resolveSpawnModel(config, { profileName: "anthropic", agent: "scout", requestedModel: "google/gemini-4" }), {
		action: "skip",
		reason: 'explicit model "google/gemini-4" is not in any profile',
	});
	assert.deepEqual(resolveSpawnModel(config, { profileName: "anthropic", agent: "unknown", agentModel: "google/gemini-4" }), {
		action: "skip",
		reason: 'no tier known for "google/gemini-4"',
	});
	assert.deepEqual(resolveSpawnModel(config, { profileName: "ghost", agent: "scout" }), { action: "skip", reason: 'unknown profile "ghost"' });
	assert.equal(resolveSpawnModel(config, { profileName: "anthropic", agent: "reviewer", agentModel: "anthropic/claude-opus-5" }).action, "skip");
});

test("a bare spawn with no agent falls back to the profile's default tier", () => {
	const resolution = resolveSpawnModel(config, { profileName: "openai-codex" });
	assert.equal(resolution.action === "set" && resolution.model, "openai-codex/gpt-5.6-luna:high");
	assert.equal(resolution.action === "set" && resolution.source, "profile-default");

	const noDefault = parseConfig({ ...RAW, profiles: { ...RAW.profiles, anthropic: { ...RAW.profiles.anthropic, defaultTier: undefined } } });
	assert.deepEqual(resolveSpawnModel(noDefault, { profileName: "anthropic" }), { action: "skip", reason: "no agent model, role, or tier to map" });
});

test("a missing tier in the target profile is skipped rather than downgraded", () => {
	const sparse = parseConfig({ ...RAW, profiles: { ...RAW.profiles, "openai-codex": { providers: ["openai-codex"], defaultTier: "cheap", tiers: { cheap: { model: "openai-codex/gpt-5.6-luna" } } } } });
	assert.deepEqual(resolveSpawnModel(sparse, { profileName: "openai-codex", agent: "reviewer" }), {
		action: "skip",
		reason: 'profile "openai-codex" has no "capable" tier',
	});
});

test("patching a role writes shorthand or object form and keeps the rest of the file", () => {
	const raw = JSON.stringify(RAW, null, 2);
	const added = JSON.parse(patchRole(raw, "oracle", { tier: "frontier" }));
	assert.equal(added.roles.oracle, "frontier");
	assert.equal(added.roles.scout, "cheap");
	assert.deepEqual(added.profiles, RAW.profiles);

	const withThinking = JSON.parse(patchRole(raw, "scout", { tier: "cheap", thinking: "low" }));
	assert.deepEqual(withThinking.roles.scout, { tier: "cheap", thinking: "low" });

	const removed = JSON.parse(patchRole(raw, "scout", undefined));
	assert.equal("scout" in removed.roles, false);

	assert.throws(() => patchRole(raw, "  ", { tier: "cheap" }), /must not be empty/);
});

test("patching a tier sets, unsets, and re-validates the result", () => {
	const raw = JSON.stringify(RAW, null, 2);
	const set = JSON.parse(patchTier(raw, "anthropic", "frontier", { model: "anthropic/claude-fable-5", thinking: "max" }));
	assert.deepEqual(set.profiles.anthropic.tiers.frontier, { model: "anthropic/claude-fable-5", thinking: "max" });
	assert.deepEqual(set.roles, RAW.roles);

	const unset = JSON.parse(patchTier(raw, "anthropic", "capable", undefined));
	assert.equal("capable" in unset.profiles.anthropic.tiers, false);

	assert.throws(() => patchTier(raw, "ghost", "cheap", { model: "x/y" }), /profile "ghost"/);
	const single = JSON.stringify({ fallbackProfile: "anthropic", profiles: { anthropic: { providers: ["anthropic"], tiers: { cheap: { model: "anthropic/claude-haiku-4-5" } } } } });
	assert.throws(() => patchTier(single, "anthropic", "cheap", undefined), /no tiers/);
});

test("default tier patch validates binding and preserves other data", () => {
	const raw = JSON.stringify({ ...RAW, extra: { retained: true } });
	const updated = JSON.parse(patchDefaultTier(raw, "anthropic", "standard"));
	assert.equal(updated.profiles.anthropic.defaultTier, "standard");
	assert.deepEqual(updated.profiles["openai-codex"], RAW.profiles["openai-codex"]);
	assert.deepEqual(updated.roles, RAW.roles);
	assert.deepEqual(updated.extra, { retained: true });
	assert.throws(() => patchDefaultTier(raw, "missing", "cheap"), /profile "missing"/);
	assert.throws(() => patchDefaultTier(raw, "anthropic", "cheapest"), /no "cheapest" tier/);
	assert.throws(() => patchDefaultTier(raw, "anthropic", "invalid" as never), /unknown tier/);
});

test("changed default applies only after explicit and role choices", () => {
	const changed = parseConfig(JSON.parse(patchDefaultTier(JSON.stringify(RAW), "anthropic", "standard")));
	assert.equal(resolveSpawnModel(changed, { profileName: "anthropic" }).action === "set" && (resolveSpawnModel(changed, { profileName: "anthropic" }) as { model: string }).model, "anthropic/claude-sonnet-5:high");
	assert.equal((resolveSpawnModel(changed, { profileName: "anthropic", agent: "scout" }) as { model: string }).model, "anthropic/claude-haiku-4-5:high");
	assert.equal((resolveSpawnModel(changed, { profileName: "anthropic", agent: "scout", requestedModel: "frontier" }) as { model: string }).model, "anthropic/claude-fable-5-1:xhigh");
	assert.deepEqual(resolveSpawnModel(changed, { profileName: "anthropic", agent: "scout", requestedModel: "openai-codex/gpt-5.6-sol" }), {
		action: "set", model: "anthropic/claude-opus-5:xhigh", tier: "capable", source: "requested-model", previous: "openai-codex/gpt-5.6-sol",
	});
});

test("editor lines render current state", () => {
	assert.match(formatRoleLine("worker", config.roles.worker, config, "openai-codex"), /worker\s+standard\s+openai-codex\/gpt-5\.6-terra:medium/);
	assert.match(formatRoleLine("ghost", undefined, config, "anthropic"), /ghost\s+\(unmapped\)/);
	const noFrontier = parseConfig({ ...RAW, profiles: { ...RAW.profiles, anthropic: { providers: ["anthropic"], tiers: { cheap: { model: "anthropic/claude-haiku-4-5" } } } } });
	assert.match(formatRoleLine("worker", { tier: "frontier" }, noFrontier, "anthropic"), /tier missing in profile/);
	assert.match(formatTierLine("capable", config.profiles.anthropic.tiers.capable), /capable\s+anthropic\/claude-opus-5:xhigh/);
	assert.match(formatTierLine("frontier", undefined), /frontier\s+\(unset\)/);
});

test("the summary lists tiers with the roles that map to them", () => {
	const lines = formatProfileSummary(config, "openai-codex", "openai-codex", "provider");
	assert.match(lines[0], /^Profile: openai-codex \(provider, session provider openai-codex\)$/);
	assert.ok(lines.includes("Default tier: cheap"));
	const unset = parseConfig({ ...RAW, profiles: { ...RAW.profiles, anthropic: { ...RAW.profiles.anthropic, defaultTier: undefined } } });
	assert.ok(formatProfileSummary(unset, "anthropic", undefined, "fallback").includes("Default tier: (unset)"));
	assert.ok(lines.some((line) => line.includes("openai-codex/gpt-5.6-sol:xhigh") && line.includes("reviewer")));
	assert.ok(lines.some((line) => line.includes("openai-codex/gpt-6-astra:xhigh")));
});

test("thinking levels are checked against what each model supports", () => {
	const levels: Record<string, string[]> = {
		"anthropic/claude-haiku-4-5": ["off", "minimal", "low", "medium", "high"],
		"anthropic/claude-sonnet-5": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		"anthropic/claude-opus-5": ["minimal", "low", "medium", "high", "xhigh", "max"],
	};
	const withXhighHaiku = parseConfig({
		...RAW,
		profiles: { ...RAW.profiles, anthropic: { ...RAW.profiles.anthropic, tiers: { ...RAW.profiles.anthropic.tiers, cheap: { model: "anthropic/claude-haiku-4-5", thinking: "xhigh" } } } },
	});
	const warnings = thinkingWarnings(withXhighHaiku, "anthropic", (model) => levels[model]);
	assert.ok(warnings.some((line) => line.includes("claude-haiku-4-5") && line.includes("xhigh")));
	assert.ok(warnings.some((line) => line.includes("claude-fable-5-1") && line.includes("not in the model registry")));
	assert.deepEqual(
		thinkingWarnings(
			parseConfig({ ...RAW, profiles: { ...RAW.profiles, anthropic: { providers: ["anthropic"], tiers: { standard: { model: "anthropic/claude-sonnet-5", thinking: "xhigh" } } } } }),
			"anthropic",
			(model) => levels[model],
		),
		[],
	);
});
