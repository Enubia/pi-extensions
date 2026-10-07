import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../../extensions/observational-memory/src/config.js";

describe("cacheAwareCompaction config", () => {
	let root: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-cache-aware-config-"));
		cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	function load(value: unknown) {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { cacheAwareCompaction: value } }));
		return loadConfig(cwd, {}).cacheAwareCompaction;
	}

	it("defaults to enabled, 0.6 soft fraction, auto idle and model-change on", () => {
		expect(DEFAULTS.cacheAwareCompaction).toEqual({ enabled: true, softFraction: 0.6, idle: "auto", onModelChange: true });
		expect(loadConfig(cwd, {}).cacheAwareCompaction).toEqual(DEFAULTS.cacheAwareCompaction);
	});

	it("accepts valid sub-fields", () => {
		expect(load({ enabled: false, softFraction: 0.4, idle: 300, onModelChange: false })).toEqual({
			enabled: false,
			softFraction: 0.4,
			idle: 300,
			onModelChange: false,
		});
		expect(load({ idle: false })?.idle).toBe(false);
		expect(load({ idle: "auto" })?.idle).toBe("auto");
	});

	it("falls back to defaults per invalid sub-field", () => {
		expect(load({ enabled: "yes", softFraction: 1.5, idle: "soon", onModelChange: 1 })).toEqual(DEFAULTS.cacheAwareCompaction);
		for (const softFraction of [0, -0.1, 1, NaN, "0.5", null]) {
			expect(load({ softFraction })?.softFraction).toBe(0.6);
		}
		for (const idle of [0, -5, NaN, Infinity, true, null, "AUTO"]) {
			expect(load({ idle })?.idle).toBe("auto");
		}
		expect(load({ softFraction: 0.3, idle: -1 })).toEqual({ ...DEFAULTS.cacheAwareCompaction, softFraction: 0.3 });
	});

	it("ignores non-object values", () => {
		for (const value of [true, false, "on", 5, null, []]) {
			expect(load(value)).toEqual(DEFAULTS.cacheAwareCompaction);
		}
	});
});
