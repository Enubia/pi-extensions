import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { OBSERVER_SYSTEM } from "../../extensions/observational-memory/src/agents/observer/prompts.js";
import { REFLECTOR_SYSTEM } from "../../extensions/observational-memory/src/agents/reflector/prompts.js";
import { DEFAULTS } from "../../extensions/observational-memory/src/config.js";
import { runConsolidationPipeline, syncPauseStatus, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { OM_PAUSE_STATUS_KEY, parsePauseStatus } from "../../extensions/observational-memory/src/status/pause-status.js";
import type { Entry } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { observation, observationsRecordedEntry, reflection, reflectionsRecordedEntry, text, userEntry } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");

function textReply() {
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
		content: [{ type: "text", text: "Nothing to record." }],
		stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
	};
	const events = createAssistantMessageEventStream();
	events.push({ type: "done", reason: "stop", message });
	return events;
}

function harness(entries: Entry[], config: Partial<Runtime["config"]>) {
	const stages: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, agentMaxRetries: 0, showWorkerNotifications: false, ...config };
	const ctx: ConsolidationCtx = {
		cwd: "/nonexistent",
		hasUI: true,
		ui: { notify() {}, setStatus: (key, value) => void statuses.set(key, value) },
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			streamSimple: (_model: unknown, context: Context) => {
				const system = context.messages.find((message) => (message as { role: string }).role === "system") as { content?: unknown } | undefined;
				stages.push(system?.content === OBSERVER_SYSTEM ? "observer" : system?.content === REFLECTOR_SYSTEM ? "reflector" : "other");
				return textReply();
			},
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-1" },
	};
	const pi = { appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", id: `appended-${entries.length}`, customType, data }) } as unknown as ExtensionAPI;
	return {
		runtime,
		run: (force = false) => runConsolidationPipeline(pi, runtime, ctx, force),
		sync: () => syncPauseStatus(runtime, ctx),
		reflectorCalls: () => stages.filter((stage) => stage === "reflector").length,
		observerCalls: () => stages.filter((stage) => stage === "observer").length,
		paused: () => [...parsePauseStatus(statuses.get(OM_PAUSE_STATUS_KEY))],
	};
}

describe("reflector gating", () => {
	it("skips the reflector when no observations arrived since the last reflection", async () => {
		const first = userEntry("first");
		const observed = observation(1, [first.id]);
		const entries = [first, observationsRecordedEntry([observed], first.id), reflectionsRecordedEntry([reflection(2, [observed.id])], first.id), userEntry(text(500))];
		const h = harness(entries, { observeAfterTokens: 1_000_000, reflectAfterTokens: 10 });
		await h.run();
		expect(h.reflectorCalls()).toBe(0);
		await h.run(true);
		expect(h.reflectorCalls()).toBe(1);
	});

	it("remembers an empty reflector verdict until observation coverage advances", async () => {
		const first = userEntry(text(500));
		const entries: Entry[] = [first, observationsRecordedEntry([observation(1, [first.id])], first.id)];
		const h = harness(entries, { observeAfterTokens: 1_000_000, reflectAfterTokens: 10 });
		await h.run();
		await h.run();
		expect(h.reflectorCalls()).toBe(1);
		const second = userEntry(text(500));
		entries.push(second, observationsRecordedEntry([observation(3, [second.id])], second.id));
		await h.run();
		expect(h.reflectorCalls()).toBe(2);
	});
});

describe("pause status", () => {
	it("publishes paused observer and reflector stages and clears them once coverage advances", async () => {
		const first = userEntry("first");
		const observed = observation(1, [first.id]);
		const latest = userEntry(text(500));
		const entries: Entry[] = [first, observationsRecordedEntry([observed], first.id), reflectionsRecordedEntry([reflection(2, [observed.id])], first.id), latest];
		const h = harness(entries, { observeAfterTokens: 10, reflectAfterTokens: 10 });
		await h.run();
		expect(h.observerCalls()).toBe(1);
		expect(h.reflectorCalls()).toBe(0);
		expect(h.paused()).toEqual(["obs", "ref"]);
		await h.run();
		expect(h.observerCalls()).toBe(1);
		entries.push(observationsRecordedEntry([observation(3, [latest.id])], latest.id));
		h.sync();
		expect(h.paused()).toEqual([]);
	});
});
