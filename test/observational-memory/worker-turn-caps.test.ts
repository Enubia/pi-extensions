import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { runObserver } from "../../extensions/observational-memory/src/agents/observer/agent.js";
import { runReflector } from "../../extensions/observational-memory/src/agents/reflector/agent.js";
import { runDropper } from "../../extensions/observational-memory/src/agents/dropper/agent.js";
import type { WorkerStreamSimple } from "../../extensions/observational-memory/src/agents/worker-stream.js";
import { observation } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");
const observations = Array.from({ length: 8 }, (_, index) => ({ ...observation(index + 1, ["entry-1"]), tokenCount: 100 }));
type Options = { streamSimple: WorkerStreamSimple; maxTurns?: number; signal?: AbortSignal; onCost?: (usd: number) => void };
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
const workers = [
	{
		name: "observer",
		run: (options: Options) => runObserver({ model, priorReflections: [], priorObservations: [], chunk: "[Source entry id: entry-1] Synthetic facts.", allowedSourceEntryIds: ["entry-1"], ...options }),
		call: (seed: number, valid = true): ToolCall => ({ type: "toolCall", id: `call-${seed}`, name: "record_observations", arguments: { observations: [{ timestamp: "2030-01-01 10:00", content: `Synthetic fact ${seed}.`, relevance: "medium", sourceEntryIds: [valid ? "entry-1" : "missing"] }] } }),
		result: (seeds: number[]) => seeds.map((seed) => ({ content: `Synthetic fact ${seed}.`, sourceEntryIds: ["entry-1"] })),
	},
	{
		name: "reflector",
		run: (options: Options) => runReflector({ model, reflections: [], observations, ...options }),
		call: (seed: number, valid = true): ToolCall => ({ type: "toolCall", id: `call-${seed}`, name: "record_reflections", arguments: { reflections: [{ content: `Synthetic fact ${seed}.`, supportingObservationIds: [valid ? observations[0].id : "missing"] }] } }),
		result: (seeds: number[]) => seeds.map((seed) => ({ content: `Synthetic fact ${seed}.`, supportingObservationIds: [observations[0].id] })),
	},
	{
		name: "dropper",
		run: (options: Options) => runDropper({ model, reflections: [], observations, targetTokens: 1, ...options }),
		call: (seed: number, valid = true): ToolCall => ({ type: "toolCall", id: `call-${seed}`, name: "drop_observations", arguments: { ids: [valid ? observations[seed - 1].id : "missing"] } }),
		result: (seeds: number[]) => seeds.map((seed) => observations[seed - 1].id),
	},
];

function response(content: AssistantMessage["content"], stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "toolUse") {
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, content, stopReason,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: "Synthetic failure" } : {}),
	};
	const stream = createAssistantMessageEventStream();
	if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
	else stream.push({ type: "done", reason: stopReason, message });
	return stream;
}

for (const worker of workers) describe(`${worker.name} real-loop turn cap`, () => {
	it("finishes the entire successful batch at cap one without a follow-up request", async () => {
		let requests = 0;
		const costs: number[] = [];
		const records = await worker.run({ maxTurns: 1, onCost: (cost) => costs.push(cost), streamSimple: () => {
			requests++;
			return requests === 1 ? response([worker.call(1), worker.call(2)]) : response([{ type: "text", text: "Done." }], "stop");
		} });
		expect(requests).toBe(1);
		expect(records).toMatchObject(worker.result([1, 2]));
		expect(costs).toEqual([0.03]);
	});

	it("allows successful tool turns below a multi-turn cap and retains their acknowledgements", async () => {
		const requests: Context[] = [];
		const costs: number[] = [];
		const records = await worker.run({ maxTurns: 3, onCost: (cost) => costs.push(cost), streamSimple: (_model, context) => {
			requests.push({ ...context, messages: structuredClone(context.messages) });
			return requests.length <= 3 ? response([worker.call(requests.length)]) : response([{ type: "text", text: "Safety bound." }], "stop");
		} });
		expect(requests).toHaveLength(3);
		expect(records).toMatchObject(worker.result([1, 2, 3]));
		expect(costs).toEqual([0.03, 0.03, 0.03]);
		const results = requests[2].messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.map((result) => result.toolCallId)).toEqual(["call-1", "call-2"]);
		expect(results.every((result) => !result.isError && result.content.length > 0)).toBe(true);
	});

	for (const maxTurns of [1, 3]) for (const failure of ["filtered", "invalid", "truncated"]) it(`bounds ${failure} tool retries at ${maxTurns} turns without collecting records`, async () => {
		let requests = 0;
		const records = await worker.run({ maxTurns, streamSimple: () => {
			requests++;
			if (requests > maxTurns) return response([{ type: "text", text: "Safety bound." }], "stop");
			const call = worker.call(1, failure !== "filtered");
			return response([{ ...call, ...(failure === "invalid" ? { arguments: {} } : {}) }], failure === "truncated" ? "length" : "toolUse");
		} });
		expect(requests).toBe(maxTurns);
		expect(records).toBeUndefined();
	});

	for (const maxTurns of [undefined, 0, -1, 5]) it(`preserves natural completion and multiple batches with maxTurns ${maxTurns}`, async () => {
		let requests = 0;
		const records = await worker.run({ maxTurns, streamSimple: () => {
			requests++;
			return requests <= 2 ? response([worker.call(requests)]) : response([{ type: "text", text: "Done." }], "stop");
		} });
		expect(requests).toBe(3);
		expect(records).toMatchObject(worker.result([1, 2]));
	});

	for (const stopReason of ["error", "aborted"] as const) for (const collected of [false, true]) it(`preserves ${stopReason} handling with prior records ${collected}`, async () => {
		let requests = 0;
		const controller = new AbortController();
		const run = worker.run({ maxTurns: collected ? 3 : 1, signal: controller.signal, streamSimple: (_model, _context, options) => {
			requests++;
			expect(options?.signal).toBe(controller.signal);
			if (collected && requests === 1) return response([worker.call(1)]);
			if (stopReason === "aborted") controller.abort();
			return response([], stopReason);
		} });
		if (!collected && worker.name === "observer") await expect(run).rejects.toMatchObject({ name: "ObserverStreamError", stopReason });
		else if (collected) expect(await run).toMatchObject(worker.result([1]));
		else expect(await run).toBeUndefined();
		expect(requests).toBe(collected ? 2 : 1);
	});
});
