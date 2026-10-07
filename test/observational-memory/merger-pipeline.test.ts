import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
import { DROPPER_SYSTEM } from "../../extensions/observational-memory/src/agents/dropper/prompts.js";
import { MERGER_SYSTEM } from "../../extensions/observational-memory/src/agents/merger/prompts.js";
import { OBSERVER_SYSTEM } from "../../extensions/observational-memory/src/agents/observer/prompts.js";
import { REFLECTOR_SYSTEM } from "../../extensions/observational-memory/src/agents/reflector/prompts.js";
import { DEFAULTS } from "../../extensions/observational-memory/src/config.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import {
	OM_COST,
	OM_REFLECTIONS_RECORDED,
	foldLedger,
	type Entry,
} from "../../extensions/observational-memory/src/session-ledger/index.js";
import { observation, observationsRecordedEntry, reflection, reflectionsRecordedEntry, userEntry } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");

type Reply = { kind: "text" } | { kind: "tool"; name: string; arguments: Record<string, JsonValue> } | { kind: "error"; message: string };
type Stage = "observer" | "reflector" | "merger" | "dropper";

function stageOf(context: Context): Stage | undefined {
	const system = context.messages.find((message) => (message as { role: string }).role === "system") as { content?: unknown } | undefined;
	if (system?.content === OBSERVER_SYSTEM) return "observer";
	if (system?.content === REFLECTOR_SYSTEM) return "reflector";
	if (system?.content === MERGER_SYSTEM) return "merger";
	if (system?.content === DROPPER_SYSTEM) return "dropper";
	return undefined;
}

function stream(reply: Reply) {
	const toolUse = reply.kind === "tool";
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
		content: toolUse ? [{ type: "toolCall", id: "call", name: reply.name, arguments: reply.arguments }] : reply.kind === "text" ? [{ type: "text", text: "Done." }] : [],
		stopReason: toolUse ? "toolUse" : reply.kind === "text" ? "stop" : "error",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		...(reply.kind === "error" ? { errorMessage: reply.message } : {}),
	};
	const events = createAssistantMessageEventStream();
	if (reply.kind === "error") events.push({ type: "error", reason: "error", error: message });
	else events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	return events;
}

const LONG = "Durable fact about the project that is deliberately long enough to weigh on the reflection pool budget";
const user = userEntry("hello");
const observations = [1, 2, 3, 4].map((seed) => ({ ...observation(seed, [user.id]), tokenCount: 100 }));
const reflections = Array.from({ length: 4 }, (_, index) =>
	reflection(100 + index, [observations[index].id], undefined, `${LONG} number ${index}.`));
const newReflection: Reply = {
	kind: "tool",
	name: "record_reflections",
	arguments: { reflections: [{ content: "Brand new durable decision.", supportingObservationIds: [observations[0].id] }] },
};

function harness(options: { scripts?: Partial<Record<Stage, Reply[]>>; config?: Partial<Runtime["config"]>; reflectionCount?: number } = {}) {
	const entries: Entry[] = [
		user,
		observationsRecordedEntry(observations, user.id),
		reflectionsRecordedEntry(reflections.slice(0, options.reflectionCount ?? reflections.length), user.id, "refl-entry"),
	];
	const pending: Partial<Record<Stage, Reply[]>> = Object.fromEntries(Object.entries(options.scripts ?? {}).map(([name, replies]) => [name, [...replies!]]));
	const requests: { stage: Stage | undefined; phase: string | undefined; context: Context }[] = [];
	const appended: { customType: string; data: any }[] = [];
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...DEFAULTS,
		observeAfterTokens: 1,
		reflectAfterTokens: 1_000_000,
		agentMaxRetries: 0,
		reflectionsPoolMaxTokens: 100,
		reflectionsPoolTargetTokens: 40,
		observationsPoolTargetTokens: 1,
		showWorkerNotifications: false,
		...options.config,
	};
	const ctx: ConsolidationCtx = {
		cwd: "/nonexistent",
		hasUI: false,
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			streamSimple: (_model: unknown, context: Context) => {
				const stage = stageOf(context);
				requests.push({ stage, phase: runtime.consolidationPhase, context: { ...context, messages: structuredClone(context.messages) } });
				return stream(pending[stage ?? "observer"]?.shift() ?? { kind: "text" });
			},
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-1" },
	};
	let counter = 0;
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
			entries.push({ type: "custom", id: `appended-${++counter}`, customType, data });
		},
	} as unknown as ExtensionAPI;
	return {
		runtime, entries, requests, appended,
		run: () => runConsolidationPipeline(pi, runtime, ctx, true),
		runUnforced: () => runConsolidationPipeline(pi, runtime, ctx, false),
		mergerCalls: () => requests.filter((request) => request.stage === "merger").length,
		addReflection: (seed: number) => {
			entries.push(reflectionsRecordedEntry([reflection(seed, [observations[0].id], undefined, `${LONG} extra ${seed}.`)], user.id, `extra-${seed}`));
		},
		stagesCalled: () => requests.map((request) => request.stage),
		recordedReflections: () => appended.filter((entry) => entry.customType === OM_REFLECTIONS_RECORDED),
	};
}

function merge(sources: { id: string }[], content = "Merged durable project fact.") {
	return { kind: "tool", name: "merge_reflections", arguments: { merged: [{ content, supersedesReflectionIds: sources.map((item) => item.id) }] } } satisfies Reply;
}

describe("merger stage", () => {
	it("skips the merger on later passes after a zero-merge run while the active reflection set is unchanged", async () => {
		const h = harness();
		await h.runUnforced();
		expect(h.mergerCalls()).toBe(1);
		await h.runUnforced();
		await h.runUnforced();
		expect(h.mergerCalls()).toBe(1);
	});

	it("re-enables the merger when the active reflection set changes", async () => {
		const h = harness();
		await h.runUnforced();
		h.addReflection(200);
		await h.runUnforced();
		expect(h.mergerCalls()).toBe(2);
	});

	it("ignores the zero-merge memo on a forced consolidation", async () => {
		const h = harness();
		await h.runUnforced();
		await h.run();
		expect(h.mergerCalls()).toBe(2);
	});

	it("does not remember a merger run that failed", async () => {
		const h = harness({ scripts: { merger: [{ kind: "error", message: "Synthetic failure" }] } });
		await h.runUnforced();
		await h.runUnforced();
		expect(h.mergerCalls()).toBe(2);
	});

	it("never calls the merger while the active reflection pool is under the max", async () => {
		const h = harness({ config: { reflectionsPoolMaxTokens: 100_000 } });
		await h.run();
		expect(h.stagesCalled()).toEqual(["reflector"]);
		expect(h.recordedReflections()).toEqual([]);
	});

	it("never calls the merger when fewer than two reflections are active", async () => {
		const h = harness({ reflectionCount: 1, config: { reflectionsPoolMaxTokens: 0, reflectionsPoolTargetTokens: 0 } });
		await h.run();
		expect(h.stagesCalled()).toEqual(["reflector"]);
	});

	it("runs after the reflector and records a merged reflection that supersedes its sources without advancing coverage", async () => {
		const h = harness({ scripts: { merger: [merge(reflections.slice(0, 3))] } });
		await h.run();
		expect(h.stagesCalled()).toEqual(["reflector", "merger", "merger"]);
		const recorded = h.recordedReflections();
		expect(recorded).toHaveLength(1);
		expect(recorded[0].data.coversUpToId).toBe(user.id);
		const [merged] = recorded[0].data.reflections;
		expect(merged.supersedesReflectionIds).toEqual(reflections.slice(0, 3).map((item) => item.id).sort());
		expect(merged.supportingObservationIds).toEqual(observations.slice(0, 3).map((item) => item.id));
		expect(foldLedger(h.entries).reflections.map((item) => item.id)).toEqual([reflections[3].id, merged.id]);
	});

	it("records merger spend under the merger cost stage", async () => {
		const h = harness({ scripts: { merger: [merge(reflections.slice(0, 3))] } });
		await h.run();
		const cost = h.appended.find((entry) => entry.customType === OM_COST);
		expect(cost?.data.stages.reflector).toBeCloseTo(0.03);
		expect(cost?.data.stages.merger).toBeCloseTo(0.06);
		expect(cost?.data.usd).toBeCloseTo(0.09);
	});

	it("is skipped when the reflector stage fails", async () => {
		const h = harness({ scripts: { reflector: [{ kind: "error", message: "Synthetic failure" }] } });
		await h.run();
		expect(h.stagesCalled()).toEqual(["reflector"]);
		expect(h.runtime.lastReflectorError).toContain("Synthetic failure");
	});

	it("surfaces merger failures as a merger stage error without blocking the dropper", async () => {
		const h = harness({ scripts: { reflector: [newReflection], merger: [{ kind: "error", message: "Synthetic failure" }] } });
		await h.run();
		expect(h.runtime.lastMergerError).toContain("Synthetic failure");
		expect(h.stagesCalled()).toContain("dropper");
	});

	it("gives the dropper the merged reflections instead of the superseded ones", async () => {
		const h = harness({ scripts: { reflector: [newReflection], merger: [merge(reflections.slice(0, 3))] } });
		await h.run();
		const dropper = h.requests.find((request) => request.stage === "dropper");
		expect(dropper).toBeDefined();
		const text = JSON.stringify(dropper!.context.messages.at(-1));
		expect(text).toContain("Merged durable project fact.");
		expect(text).toContain("Brand new durable decision.");
		for (const superseded of reflections.slice(0, 3)) expect(text).not.toContain(superseded.content);
		expect(text).toContain(reflections[3].content);
	});

	it("reports the merger phase while running", async () => {
		const h = harness({ scripts: { merger: [merge(reflections.slice(0, 3))] } });
		await h.run();
		expect(h.requests.map((request) => request.phase)).toEqual(["reflector", "merger", "merger"]);
	});
});
