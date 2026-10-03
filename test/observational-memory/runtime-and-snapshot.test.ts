import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { runDropper } from "../../extensions/observational-memory/src/agents/dropper/agent.js";
import { DROPPER_SYSTEM } from "../../extensions/observational-memory/src/agents/dropper/prompts.js";
import { runReflector } from "../../extensions/observational-memory/src/agents/reflector/agent.js";
import { REFLECTOR_SYSTEM } from "../../extensions/observational-memory/src/agents/reflector/prompts.js";
import type { WorkerStreamSimple } from "../../extensions/observational-memory/src/agents/worker-stream.js";
import { runObserver } from "../../extensions/observational-memory/src/agents/observer/agent.js";
import { OBSERVER_SYSTEM } from "../../extensions/observational-memory/src/agents/observer/prompts.js";
import { costFromAgentEvent } from "../../extensions/observational-memory/src/agents/usage-cost.js";
import { readEnabledFromLedger, Runtime, sumCostEntries } from "../../extensions/observational-memory/src/runtime.js";
import { memorySnapshot } from "../../extensions/observational-memory/src/status/snapshot.js";
import { assistantEntry, costEntry, enabledEntry, observation, text, userEntry } from "./fixtures.js";

describe("worker request context", () => {
	const model = getBuiltinModel("openai", "gpt-4o");
	const observations = [observation(1, ["entry-1"], "Keep the widget blue.")];
	const cases: { name: string; system: string; tool: string; user: string; run: (streamSimple: WorkerStreamSimple) => Promise<unknown> }[] = [
		{
			name: "observer", system: OBSERVER_SYSTEM, tool: "record_observations", user: "[Source entry id: entry-1] Keep the widget blue.",
			run: (streamSimple) => runObserver({ model, priorReflections: ["Prior stable fact."], priorObservations: ["Prior observation."],
				chunk: "[Source entry id: entry-1] Keep the widget blue.", allowedSourceEntryIds: ["entry-1"], streamSimple }),
		},
		{
			name: "reflector", system: REFLECTOR_SYSTEM, tool: "record_reflections", user: "Keep the widget blue.",
			run: (streamSimple) => runReflector({ model, reflections: [], observations, streamSimple }),
		},
		{
			name: "dropper", system: DROPPER_SYSTEM, tool: "drop_observations", user: "Keep the widget blue.",
			run: (streamSimple) => runDropper({ model, reflections: [], observations, targetTokens: 1, streamSimple }),
		},
	];
	for (const worker of cases) it(`sends ${worker.name} instructions exactly once before user content and retains its tool through the real host loop`, async () => {
		const requests: Context[] = [];
		await worker.run((_model, context) => {
			requests.push({ ...context, messages: structuredClone(context.messages) });
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: "Done." }], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: 0,
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].messages[0]).toMatchObject({ role: "system", content: worker.system });
		expect(requests[0].messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
		const systems = requests[0].messages.filter((message) => message.role === "system");
		expect(systems.filter((message) => message.content === worker.system)).toHaveLength(1);
		expect(systems.flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name)).toEqual([worker.tool]);
		const user = requests[0].messages[2];
		expect(user.role).toBe("user");
		expect(JSON.stringify(user.content)).toContain(worker.user);
		expect(JSON.stringify(user.content)).toContain("CURRENT REFLECTIONS:");
		expect(JSON.stringify(user.content)).toContain("CURRENT OBSERVATIONS:");
	});
});

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
