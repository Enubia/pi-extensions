import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { runMerger } from "../../extensions/observational-memory/src/agents/merger/agent.js";
import { MERGER_SYSTEM } from "../../extensions/observational-memory/src/agents/merger/prompts.js";
import { WorkerStreamError } from "../../extensions/observational-memory/src/agents/stream-errors.js";
import type { WorkerStreamSimple } from "../../extensions/observational-memory/src/agents/worker-stream.js";
import { memoryId, reflection } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");
type Merge = { content: string; supersedesReflectionIds: string[] };

function response(content: AssistantMessage["content"], stopReason: "toolUse" | "stop" | "error" = "toolUse") {
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, content, stopReason,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		...(stopReason === "error" ? { errorMessage: "429 Too Many Requests" } : {}),
	};
	const stream = createAssistantMessageEventStream();
	if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: stopReason, message });
	return stream;
}

function mergeCall(merged: Merge[], id = "call-1"): AssistantMessage["content"] {
	return [{ type: "toolCall", id, name: "merge_reflections", arguments: { merged } }];
}

function scripted(...turns: AssistantMessage["content"][]): { streamSimple: WorkerStreamSimple; requests: Context[] } {
	const requests: Context[] = [];
	return {
		requests,
		streamSimple: (_model, context) => {
			requests.push({ ...context, messages: structuredClone(context.messages) });
			const turn = turns[requests.length - 1];
			return turn ? response(turn) : response([{ type: "text", text: "Done." }], "stop");
		},
	};
}

const reflections = [
	reflection(1, [memoryId(101)], undefined, "User prefers tabs over spaces for indentation in every file."),
	reflection(2, [memoryId(102), memoryId(103)], undefined, "User stated tabs are required for indentation, never spaces."),
	reflection(3, [memoryId(104)], undefined, "The project database is Postgres."),
];
const observationIds = [101, 102, 103, 104].map(memoryId);

function run(streamSimple: WorkerStreamSimple, overrides: Partial<Parameters<typeof runMerger>[0]> = {}) {
	return runMerger({ model, reflections, observationIds, targetTokens: 0, streamSimple, ...overrides });
}

describe("runMerger", () => {
	it("merges reflections with the union of supporting observations and the superseded ids", async () => {
		const { streamSimple } = scripted(mergeCall([{ content: "User requires tabs, never spaces, for indentation.", supersedesReflectionIds: [reflections[1].id, reflections[0].id] }]));
		const result = await run(streamSimple);
		expect(result).toHaveLength(1);
		expect(result![0]).toMatchObject({
			content: "User requires tabs, never spaces, for indentation.",
			supportingObservationIds: [memoryId(101), memoryId(102), memoryId(103)],
			supersedesReflectionIds: [reflections[0].id, reflections[1].id].sort(),
		});
		expect(result![0].id).toMatch(/^[a-f0-9]{12}$/);
		expect(result![0].tokenCount).toBe(Math.ceil("User requires tabs, never spaces, for indentation.".length / 4));
	});

	it("derives a deterministic id from content and the sorted superseded ids", async () => {
		const merge = (ids: string[], content = "Tabs only.") => run(scripted(mergeCall([{ content, supersedesReflectionIds: ids }])).streamSimple);
		const [a, b] = await Promise.all([merge([reflections[0].id, reflections[1].id]), merge([reflections[1].id, reflections[0].id])]);
		expect(a![0].id).toBe(b![0].id);
		const different = await merge([reflections[0].id, reflections[1].id], "Tabs only, always.");
		expect(different![0].id).not.toBe(a![0].id);
		const fewer = await merge([reflections[0].id]);
		expect(fewer![0].id).not.toBe(a![0].id);
	});

	it("filters supporting observation ids to ids that exist in the ledger", async () => {
		const { streamSimple } = scripted(mergeCall([{ content: "Tabs only.", supersedesReflectionIds: [reflections[0].id, reflections[1].id] }]));
		const result = await run(streamSimple, { observationIds: [memoryId(101), memoryId(103)] });
		expect(result![0].supportingObservationIds).toEqual([memoryId(101), memoryId(103)]);
	});

	it("rejects items per item rather than per run", async () => {
		const { streamSimple } = scripted(mergeCall([
			{ content: "Unknown id merge.", supersedesReflectionIds: [reflections[0].id, memoryId(999)] },
			{ content: "   ", supersedesReflectionIds: [reflections[0].id] },
			{ content: "Two\nlines.", supersedesReflectionIds: [reflections[0].id] },
			{ content: "No ids.", supersedesReflectionIds: [] },
			{ content: "Tabs only.", supersedesReflectionIds: [reflections[0].id, reflections[1].id] },
			{ content: "Reuses a consumed id.", supersedesReflectionIds: [reflections[1].id, reflections[2].id] },
		]));
		const result = await run(streamSimple);
		expect(result?.map((merged) => merged.content)).toEqual(["Tabs only."]);
	});

	it("rejects an item when none of the supporting observations exist in the ledger", async () => {
		const { streamSimple } = scripted(mergeCall([{ content: "Tabs only.", supersedesReflectionIds: [reflections[0].id] }]));
		expect(await run(streamSimple, { observationIds: [memoryId(999)] })).toBeUndefined();
	});

	it("returns undefined when the model proposes no merges", async () => {
		const { streamSimple, requests } = scripted();
		expect(await run(streamSimple)).toBeUndefined();
		expect(requests).toHaveLength(1);
	});

	it("stops accepting merges once the projected pool is at or below the target", async () => {
		const pool = reflections.reduce((sum, item) => sum + Math.ceil(`[${item.id}] ${item.content}`.length / 4), 0);
		const { streamSimple } = scripted(mergeCall([
			{ content: "Tabs.", supersedesReflectionIds: [reflections[0].id, reflections[1].id] },
			{ content: "Postgres.", supersedesReflectionIds: [reflections[2].id] },
		]));
		const result = await run(streamSimple, { targetTokens: pool - 10 });
		expect(result?.map((merged) => merged.content)).toEqual(["Tabs."]);
	});

	it("sends the pool, budget and system prompt to the model and reports cost", async () => {
		const costs: number[] = [];
		const { streamSimple, requests } = scripted(mergeCall([{ content: "Tabs only.", supersedesReflectionIds: [reflections[0].id] }]));
		await run(streamSimple, { onCost: (usd) => costs.push(usd), targetTokens: 123 });
		expect(requests[0].messages[0]).toMatchObject({ role: "system", content: MERGER_SYSTEM });
		const user = JSON.stringify(requests[0].messages.at(-1));
		for (const item of reflections) expect(user).toContain(`[${item.id}] ${item.content}`);
		expect(user).toContain("123");
		expect(costs).toEqual([0.03, 0.03]);
	});

	it("throws a worker stream error when the stream fails before any merge is accepted", async () => {
		const failing: WorkerStreamSimple = () => response([], "error");
		await expect(run(failing)).rejects.toBeInstanceOf(WorkerStreamError);
		await expect(run(failing)).rejects.toThrow('merger stream ended with stopReason "error": 429 Too Many Requests');
	});
});
