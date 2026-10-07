import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../../extensions/observational-memory/src/config.js";

describe("reflection pool budgets", () => {
	let root: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-reflection-pool-config-"));
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

	function load(settings: Record<string, unknown>) {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": settings }));
		const config = loadConfig(cwd, {});
		return [config.reflectionsPoolMaxTokens, config.reflectionsPoolTargetTokens];
	}

	it("defaults to 8000 max and 4000 target", () => {
		expect(DEFAULTS.reflectionsPoolMaxTokens).toBe(8_000);
		expect(DEFAULTS.reflectionsPoolTargetTokens).toBe(4_000);
		const config = loadConfig(cwd, {});
		expect([config.reflectionsPoolMaxTokens, config.reflectionsPoolTargetTokens]).toEqual([8_000, 4_000]);
	});

	it("accepts non-negative integers with target at or below max", () => {
		expect(load({ reflectionsPoolMaxTokens: 6000, reflectionsPoolTargetTokens: 3000 })).toEqual([6000, 3000]);
		expect(load({ reflectionsPoolMaxTokens: 3000, reflectionsPoolTargetTokens: 3000 })).toEqual([3000, 3000]);
		expect(load({ reflectionsPoolMaxTokens: 0, reflectionsPoolTargetTokens: 0 })).toEqual([0, 0]);
	});

	it("falls back to the default for each invalid value", () => {
		for (const value of [-1, null, "100", true, 1.5]) {
			expect(load({ reflectionsPoolMaxTokens: value })).toEqual([8_000, 4_000]);
			expect(load({ reflectionsPoolTargetTokens: value })).toEqual([8_000, 4_000]);
		}
		expect(load({ reflectionsPoolMaxTokens: 10_000, reflectionsPoolTargetTokens: -5 })).toEqual([10_000, 4_000]);
	});

	it("falls back to both defaults when the target exceeds the max", () => {
		expect(load({ reflectionsPoolMaxTokens: 2000, reflectionsPoolTargetTokens: 3000 })).toEqual([8_000, 4_000]);
		expect(load({ reflectionsPoolMaxTokens: 2000 })).toEqual([8_000, 4_000]);
		expect(load({ reflectionsPoolTargetTokens: 9000 })).toEqual([8_000, 4_000]);
	});
});
