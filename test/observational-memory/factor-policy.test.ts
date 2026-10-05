import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig, resolveCompactionPolicy } from "../../extensions/observational-memory/src/config.js";
import { registerStatusCommand } from "../../extensions/observational-memory/src/commands/status.js";
import { registerCompactionTrigger } from "../../extensions/observational-memory/src/hooks/compaction-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { invalidateSnapshotConfig, memorySnapshot } from "../../extensions/observational-memory/src/status/snapshot.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "om-factor-policy-"));
	cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	invalidateSnapshotConfig();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	invalidateSnapshotConfig();
	rmSync(root, { recursive: true, force: true });
});

function settings(global: object, project: object = {}) {
	writeFileSync(join(root, "settings.json"), JSON.stringify({ "observational-memory": global }));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": project }));
	return loadConfig(cwd, {});
}

describe("provider policy", () => {
	it("uses exact provider overrides even with calibrated defaults and changes provider without reloading", () => {
		const config = settings({ compactAfterTokensRatioByProvider: { openai: 0.5, anthropic: 0.15 } });
		expect(resolveCompactionPolicy(config, { provider: "openai", contextWindow: 272_000 })).toMatchObject({ threshold: 136_000, source: "global-provider", mode: "ratio" });
		expect(resolveCompactionPolicy(config, { provider: "anthropic", contextWindow: 1_000_000 }).threshold).toBe(150_000);
		expect(resolveCompactionPolicy(config, { provider: "openai-codex", contextWindow: 272_000 })).toMatchObject({ threshold: DEFAULTS.compactAfterTokens, source: "defaults" });
	});

	it("keeps unrelated global provider entries when project defines another provider", () => {
		const config = settings({ compactAfterTokensRatioByProvider: { openai: 0.5, anthropic: 0.15 } }, { compactAfterTokensRatioByProvider: { anthropic: 0.2 } });
		expect(resolveCompactionPolicy(config, { provider: "openai", contextWindow: 200_000 }).threshold).toBe(100_000);
		expect(resolveCompactionPolicy(config, { provider: "anthropic", contextWindow: 200_000 })).toMatchObject({ threshold: 40_000, source: "project-provider" });
	});

	it("project scalar policy beats global provider settings but project provider wins over both", () => {
		const global = { compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.3, compactAfterTokensRatioByProvider: { openai: 0.5 } };
		const project = { compactAfterTokensRatio: 0.2 };
		expect(resolveCompactionPolicy(settings(global, project), { provider: "openai", contextWindow: 200_000 })).toMatchObject({ threshold: 40_000, source: "project-default" });
		expect(resolveCompactionPolicy(settings(global, { ...project, compactAfterTokensRatioByProvider: { openai: 0.1 } }), { provider: "openai", contextWindow: 200_000 })).toMatchObject({ threshold: 20_000, source: "project-provider" });
	});

	it("preserves partial scalar merging, including ratio-only not enabling ratio mode", () => {
		const config = settings({ compactAfterTokens: 42_000, compactAfterTokensRatioByProvider: { openai: 0.5 } }, { compactAfterTokensRatio: 0.2 });
		expect(resolveCompactionPolicy(config, { provider: "openai", contextWindow: 200_000 })).toMatchObject({ mode: "calibrated", ratio: 0.2, threshold: 42_000, source: "project-default" });
		expect(resolveCompactionPolicy(settings({ compactAfterTokensRatio: 0.4 }, { compactAfterTokensMode: "ratio" }), { contextWindow: 200_000 }).threshold).toBe(80_000);
	});

	it.each([0, 1, -0.1, "0.5", null, [], {}])("ignores invalid project ratios without masking valid global values (%s)", invalid => {
		const config = settings({ compactAfterTokensRatioByProvider: { openai: 0.5 } }, { compactAfterTokensRatioByProvider: { openai: invalid }, compactAfterTokensRatio: invalid });
		expect(resolveCompactionPolicy(config, { provider: "openai", contextWindow: 200_000 })).toMatchObject({ threshold: 100_000, source: "global-provider" });
	});

	it.each([[], "invalid", null])("rejects malformed provider maps (%s)", map => {
		const config = settings({ compactAfterTokensRatioByProvider: map });
		expect(resolveCompactionPolicy(config, { provider: "openai", contextWindow: 200_000 }).threshold).toBe(DEFAULTS.compactAfterTokens);
	});

	it("ignores nonfinite programmatic overrides", () => {
		for (const ratio of [NaN, Infinity, -Infinity]) {
			expect(resolveCompactionPolicy({ ...DEFAULTS, compactAfterTokensRatioByProvider: { openai: ratio } }, { provider: "openai", contextWindow: 200_000 }).threshold).toBe(DEFAULTS.compactAfterTokens);
		}
	});

	it("prefers effective usage window, then selected window, then calibrated fallback", () => {
		const config = settings({ compactAfterTokens: 42_000, compactAfterTokensRatioByProvider: { openai: 0.5 } });
		const model = { provider: "openai", contextWindow: 272_000 };
		expect(resolveCompactionPolicy(config, model, 100_000).threshold).toBe(50_000);
		for (const window of [undefined, 0, -1, NaN, Infinity]) {
			expect(resolveCompactionPolicy(config, model, window).threshold).toBe(136_000);
			expect(resolveCompactionPolicy(config, { provider: "openai" }, window).threshold).toBe(42_000);
		}
		expect(resolveCompactionPolicy(config).threshold).toBe(42_000);
	});

	it("trigger, status, and snapshot agree after provider switch with the same window and token count", async () => {
		const config = settings({ compactAfterTokensRatioByProvider: { openai: 0.5, anthropic: 0.15 } });
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = config;
		const on = vi.fn<ExtensionAPI["on"]>();
		const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
		const pi = { on, registerCommand } as unknown as ExtensionAPI;
		registerCompactionTrigger(pi, runtime);
		registerStatusCommand(pi, runtime);
		const ctx = {
			cwd, hasUI: true,
			model: { provider: "openai", contextWindow: 200_000 },
			getContextUsage: () => ({ tokens: 40_000, contextWindow: 200_000 }),
			sessionManager: { getBranch: () => [], getEntries: () => [] },
			ui: { notify: vi.fn() }, compact: vi.fn(),
		};
		const trigger = on.mock.calls[0][1] as (event: unknown, ctx: unknown) => void;
		for (const [provider, threshold] of [["openai", 100_000], ["anthropic", 30_000]] as const) {
			ctx.model.provider = provider;
			expect(memorySnapshot(ctx).bars[2].total).toBe(threshold);
			await registerCommand.mock.calls[0][1].handler("", ctx as unknown as ExtensionCommandContext);
			expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`/ ${threshold.toLocaleString()} tokens`), "info");
			trigger({}, ctx);
		}
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});
});
