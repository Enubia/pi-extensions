import { describe, expect, it } from "vitest";
import { costFromAgentEvent } from "../../extensions/observational-memory/src/agents/usage-cost.js";
import { readEnabledFromLedger, Runtime, sumCostEntries } from "../../extensions/observational-memory/src/runtime.js";
import { memorySnapshot } from "../../extensions/observational-memory/src/status/snapshot.js";
import { assistantEntry, costEntry, enabledEntry, text, userEntry } from "./fixtures.js";

describe("sumCostEntries", () => {
	it("sums every om.cost entry regardless of branch", () => {
		expect(sumCostEntries([userEntry("a"), costEntry(0.01), costEntry(0.02)])).toEqual({ usd: 0.03, runs: 2 });
	});

	it("ignores malformed cost entries", () => {
		expect(sumCostEntries([{ type: "custom", id: "x", customType: "om.cost", data: { nope: 1 } }])).toEqual({ usd: 0, runs: 0 });
	});
});

describe("readEnabledFromLedger", () => {
	it("defaults to on", () => {
		expect(readEnabledFromLedger([userEntry("a")])).toBe(true);
	});

	it("honours the latest gate entry on the branch", () => {
		expect(readEnabledFromLedger([enabledEntry(false), userEntry("a")])).toBe(false);
		expect(readEnabledFromLedger([enabledEntry(false), enabledEntry(true)])).toBe(true);
	});
});

describe("costFromAgentEvent", () => {
	it("reads the assistant usage cost at message_end", () => {
		const event = { type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.0042 } } } };
		expect(costFromAgentEvent(event)).toBe(0.0042);
	});

	it("ignores other events and zero cost", () => {
		expect(costFromAgentEvent({ type: "message_start", message: { role: "assistant", usage: { cost: { total: 1 } } } })).toBeUndefined();
		expect(costFromAgentEvent({ type: "message_end", message: { role: "toolResult" } })).toBeUndefined();
		expect(costFromAgentEvent({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0 } } } })).toBeUndefined();
	});
});

describe("Runtime.whenConsolidationIdle", () => {
	it("resolves immediately when nothing is running", async () => {
		await expect(new Runtime().whenConsolidationIdle()).resolves.toBeUndefined();
	});

	it("waits for the in-flight promise even when it rejects", async () => {
		const runtime = new Runtime();
		runtime.consolidationPromise = Promise.reject(new Error("worker died"));
		await expect(runtime.whenConsolidationIdle()).resolves.toBeUndefined();
		expect(runtime.consolidationPromise).toBeNull();
	});
});

describe("memorySnapshot", () => {
	it("exposes obs/ref/cmp bars, the gate, and the summed cost", () => {
		const branch = [userEntry(text(100)), assistantEntry(text(100), { usageTokens: 4_000 }), costEntry(0.5)];
		const snapshot = memorySnapshot({
			cwd: "/nonexistent",
			model: { contextWindow: 200_000 },
			getContextUsage: () => ({ tokens: 4_000 }),
			sessionManager: { getBranch: () => branch, getEntries: () => [...branch, costEntry(0.25)] },
		});

		expect(snapshot.enabled).toBe(true);
		expect(snapshot.bars.map((bar) => bar.label)).toEqual(["obs", "ref", "cmp"]);
		expect(snapshot.bars.every((bar) => bar.total > 0)).toBe(true);
		expect(snapshot.bars[2].current).toBe(4_000);
		expect(snapshot.cost).toEqual({ usd: 0.75, runs: 2 });
	});
});
