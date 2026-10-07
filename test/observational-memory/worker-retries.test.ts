import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig } from "../../extensions/observational-memory/src/config.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { DROPPER_SYSTEM } from "../../extensions/observational-memory/src/agents/dropper/prompts.js";
import { OBSERVER_SYSTEM } from "../../extensions/observational-memory/src/agents/observer/prompts.js";
import { REFLECTOR_SYSTEM } from "../../extensions/observational-memory/src/agents/reflector/prompts.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import {
	OM_COST,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
} from "../../extensions/observational-memory/src/session-ledger/index.js";
import { observation, observationsRecordedEntry, userEntry } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");
const TOOL_USE = "toolUse" as const;

type Reply = { kind: "tool" | "text" | "error" | "aborted"; message?: string };

function toolNameOf(context: Context): string | undefined {
	const system = context.messages.find((message) => (message as { role: string }).role === "system") as { content?: unknown } | undefined;
	if (system?.content === OBSERVER_SYSTEM) return "record_observations";
	if (system?.content === REFLECTOR_SYSTEM) return "record_reflections";
	if (system?.content === DROPPER_SYSTEM) return "drop_observations";
	return undefined;
}

function streamFor(reply: Reply, context: Context, entryId: string, observationIds: string[]) {
	const toolName = toolNameOf(context);
	const content: AssistantMessage["content"] = reply.kind === "tool"
		? [toolName === "record_observations"
			? { type: "toolCall", id: "call", name: toolName, arguments: { observations: [{ timestamp: "2030-01-01 10:00", content: "Synthetic fact.", relevance: "medium", sourceEntryIds: [entryId] }] } }
			: toolName === "record_reflections"
				? { type: "toolCall", id: "call", name: toolName, arguments: { reflections: [{ content: "Synthetic reflection.", supportingObservationIds: [observationIds[0]] }] } }
				: { type: "toolCall", id: "call", name: toolName ?? "", arguments: { ids: [observationIds[0]] } }]
		: reply.kind === "text" ? [{ type: "text", text: "Done." }] : [];
	const stopReason = reply.kind === "tool" ? TOOL_USE : reply.kind === "text" ? "stop" : reply.kind;
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, content, stopReason,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		...(reply.kind === "error" || reply.kind === "aborted" ? { errorMessage: reply.message ?? "Synthetic failure" } : {}),
	};
	const stream = createAssistantMessageEventStream();
	if (reply.kind === "error" || reply.kind === "aborted") stream.push({ type: "error", reason: reply.kind, error: message });
	else stream.push({ type: "done", reason: stopReason as "stop" | "toolUse", message });
	return stream;
}

const overloaded: Reply = { kind: "error", message: "429 Too Many Requests" };
const tool: Reply = { kind: "tool" };
const finish: Reply = { kind: "text" };

type Scripts = Partial<Record<"record_observations" | "record_reflections" | "drop_observations", Reply[]>>;

function setup(scripts: Scripts, options: { config?: Partial<Runtime["config"]>; entries?: Entry[]; force?: boolean } = {}) {
	const pending = Object.fromEntries(Object.entries(scripts).map(([name, replies]) => [name, [...replies]]));
	const requests: { tool: string | undefined; at: number }[] = [];
	const start = Date.now();
	const userId = "user-1";
	const observations = Array.from({ length: 8 }, (_, index) => ({ ...observation(index + 1, [userId]), tokenCount: 100 }));
	const entries = options.entries ?? [userEntry("hello world", userId)];
	const appended: { customType: string; data: any }[] = [];
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, showWorkerNotifications: false, ...options.config };
	const state = { sessionId: "session-1" };
	const ctx: ConsolidationCtx = {
		cwd: "/nonexistent",
		hasUI: false,
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			streamSimple: (_model: unknown, context: Context) => {
				const name = toolNameOf(context);
				requests.push({ tool: name, at: Date.now() - start });
				const reply = pending[name ?? ""]?.shift() ?? finish;
				return streamFor(reply, context, userId, observations.map((item) => item.id));
			},
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => state.sessionId },
	};
	const pi = { appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }) } as unknown as ExtensionAPI;
	const run = () => runConsolidationPipeline(pi, runtime, ctx, options.force === true);
	const entriesOf = (customType: string) => appended.filter((entry) => entry.customType === customType);
	return { runtime, run, requests, appended, entriesOf, state, observations, userId };
}

async function settle(run: () => Promise<void>, ms: number) {
	const promise = run();
	await vi.advanceTimersByTimeAsync(ms);
	await promise;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("observer retries", () => {
	it("retries a retryable failure once after 2s and appends a single ledger entry with summed cost", async () => {
		const h = setup({ record_observations: [overloaded, tool, finish] });
		const promise = h.run();
		await vi.advanceTimersByTimeAsync(1_999);
		expect(h.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await promise;
		expect(h.requests.map((request) => request.at)).toEqual([0, 2_000, 2_000]);
		expect(h.entriesOf(OM_OBSERVATIONS_RECORDED)).toHaveLength(1);
		const [cost] = h.entriesOf(OM_COST);
		expect(cost.data.usd).toBeCloseTo(0.09);
		expect(h.runtime.lastObserverError).toBeUndefined();
	});

	it("backs off 2s, 4s, 8s and reports the attempt count when retries are exhausted", async () => {
		const h = setup({ record_observations: [overloaded, overloaded, overloaded, overloaded] });
		await settle(h.run, 14_000);
		expect(h.requests.map((request) => request.at)).toEqual([0, 2_000, 6_000, 14_000]);
		expect(h.runtime.lastObserverError).toContain("429 Too Many Requests");
		expect(h.runtime.lastObserverError).toContain("4 attempts");
		expect(h.entriesOf(OM_OBSERVATIONS_RECORDED)).toHaveLength(0);
		expect(h.entriesOf(OM_COST)[0].data.usd).toBeCloseTo(0.12);
	});

	it("applies ±20% jitter to the delay", async () => {
		vi.mocked(Math.random).mockReturnValue(0);
		const low = setup({ record_observations: [overloaded, finish] });
		await settle(low.run, 1_600);
		expect(low.requests.map((request) => request.at)).toEqual([0, 1_600]);

		vi.mocked(Math.random).mockReturnValue(1);
		const high = setup({ record_observations: [overloaded, finish] });
		const promise = high.run();
		await vi.advanceTimersByTimeAsync(2_399);
		expect(high.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await promise;
		expect(high.requests).toHaveLength(2);
	});

	it("does not retry non-retryable failures", async () => {
		const h = setup({ record_observations: [{ kind: "error", message: "401 invalid api key" }, tool] });
		await settle(h.run, 60_000);
		expect(h.requests).toHaveLength(1);
		expect(h.runtime.lastObserverError).toContain("invalid api key");
		expect(h.runtime.lastObserverError).not.toContain("attempts");
	});

	it("does not retry aborted streams", async () => {
		const h = setup({ record_observations: [{ kind: "aborted", message: "timeout" }, tool] });
		await settle(h.run, 60_000);
		expect(h.requests).toHaveLength(1);
		expect(h.runtime.lastObserverError).toBeDefined();
	});

	it("does not retry a deliberate empty result", async () => {
		const h = setup({ record_observations: [finish, tool] });
		await settle(h.run, 60_000);
		expect(h.requests).toHaveLength(1);
		expect(h.appended).toHaveLength(1);
		expect(h.entriesOf(OM_COST)).toHaveLength(1);
	});

	it("does not retry when agentMaxRetries is 0", async () => {
		const h = setup({ record_observations: [overloaded, tool] }, { config: { agentMaxRetries: 0 } });
		await settle(h.run, 60_000);
		expect(h.requests).toHaveLength(1);
		expect(h.runtime.lastObserverError).toContain("429");
	});

	it("honours a custom agentMaxRetries", async () => {
		const h = setup({ record_observations: [overloaded, overloaded, overloaded] }, { config: { agentMaxRetries: 1 } });
		await settle(h.run, 60_000);
		expect(h.requests).toHaveLength(2);
		expect(h.runtime.lastObserverError).toContain("2 attempts");
	});

	it("cancels remaining attempts when memory is turned off during backoff", async () => {
		const h = setup({ record_observations: [overloaded, tool, finish] });
		const promise = h.run();
		await vi.advanceTimersByTimeAsync(500);
		h.runtime.enabled = false;
		await vi.advanceTimersByTimeAsync(60_000);
		await promise;
		expect(h.requests).toHaveLength(1);
		expect(h.entriesOf(OM_OBSERVATIONS_RECORDED)).toHaveLength(0);
	});

	it("cancels remaining attempts when the session changes during backoff", async () => {
		const h = setup({ record_observations: [overloaded, tool, finish] });
		const promise = h.run();
		await vi.advanceTimersByTimeAsync(500);
		h.state.sessionId = "session-2";
		await vi.advanceTimersByTimeAsync(60_000);
		await promise;
		expect(h.requests).toHaveLength(1);
		expect(h.entriesOf(OM_OBSERVATIONS_RECORDED)).toHaveLength(0);
	});

	it("keeps retrying a forced run while memory is passive but enabled", async () => {
		const h = setup({ record_observations: [overloaded, tool, finish] }, { force: true, config: { passive: true } });
		await settle(h.run, 2_000);
		expect(h.entriesOf(OM_OBSERVATIONS_RECORDED)).toHaveLength(1);
	});
});

describe("reflector retries", () => {
	function reflectorSetup(scripts: Scripts) {
		const userId = "user-1";
		const observations = Array.from({ length: 8 }, (_, index) => ({ ...observation(index + 1, [userId]), tokenCount: 100 }));
		const entries = [userEntry("hello world", userId), observationsRecordedEntry(observations, userId)];
		return setup(scripts, { entries, force: true, config: { observationsPoolMaxTokens: 100_000, observationsPoolTargetTokens: 50_000 } });
	}

	it("retries a retryable failure and appends a single reflections entry", async () => {
		const h = reflectorSetup({ record_reflections: [overloaded, tool, finish] });
		await settle(h.run, 2_000);
		expect(h.requests.filter((request) => request.tool === "record_reflections")).toHaveLength(3);
		expect(h.entriesOf(OM_REFLECTIONS_RECORDED)).toHaveLength(1);
		expect(h.entriesOf(OM_COST)[0].data.usd).toBeCloseTo(0.09);
	});

	it("records the stage error with attempt count when exhausted and aborts before the dropper", async () => {
		const h = reflectorSetup({ record_reflections: [overloaded, overloaded, overloaded, overloaded] });
		await settle(h.run, 14_000);
		expect(h.runtime.lastReflectorError).toContain("4 attempts");
		expect(h.entriesOf(OM_REFLECTIONS_RECORDED)).toHaveLength(0);
		expect(h.requests.some((request) => request.tool === "drop_observations")).toBe(false);
	});

	it("does not retry a non-retryable reflector failure", async () => {
		const h = reflectorSetup({ record_reflections: [{ kind: "error", message: "400 bad request" }, tool] });
		await settle(h.run, 60_000);
		expect(h.requests.filter((request) => request.tool === "record_reflections")).toHaveLength(1);
		expect(h.runtime.lastReflectorError).toContain("bad request");
	});
});

describe("dropper retries", () => {
	it("retries a retryable failure and appends a single dropped entry", async () => {
		const userId = "user-1";
		const observations = Array.from({ length: 8 }, (_, index) => ({ ...observation(index + 1, [userId]), tokenCount: 100 }));
		const entries = [userEntry("hello world", userId), observationsRecordedEntry(observations, userId)];
		const h = setup(
			{ record_reflections: [tool, finish], drop_observations: [overloaded, tool, finish] },
			{ entries, force: true, config: { observationsPoolMaxTokens: 400, observationsPoolTargetTokens: 100 } },
		);
		await settle(h.run, 2_000);
		expect(h.requests.filter((request) => request.tool === "drop_observations")).toHaveLength(3);
		expect(h.entriesOf(OM_OBSERVATIONS_DROPPED)).toHaveLength(1);
		expect(h.runtime.lastDropperError).toBeUndefined();
	});
});

describe("agentMaxRetries config", () => {
	let root: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-retries-config-"));
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
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { agentMaxRetries: value } }));
		return loadConfig(cwd, {}).agentMaxRetries;
	}

	it("defaults to 3", () => {
		expect(DEFAULTS.agentMaxRetries).toBe(3);
		expect(loadConfig(cwd, {}).agentMaxRetries).toBe(3);
	});

	it.each([[0, 0], [1, 1], [8, 8]])("accepts non-negative integer %s", (value, expected) => {
		expect(load(value)).toBe(expected);
	});

	it.each([[-1], [1.5], ["2"], [null], [Number.NaN], [true]])("falls back to the default for %s", (value) => {
		expect(load(value)).toBe(3);
	});
});
