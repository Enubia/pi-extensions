import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../../extensions/observational-memory/src/config.js";
import { withDebugLogContext } from "../../extensions/observational-memory/src/debug-log.js";
import { selectPriorObservations } from "../../extensions/observational-memory/src/agents/observer/prior-context.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { observationLineTokenCount } from "../../extensions/observational-memory/src/tokens.js";
import { OM_REFLECTIONS_RECORDED, type Entry, type Observation } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { memoryId, observation, observationsRecordedEntry } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");

function lineTokens(o: Observation): number {
	return observationLineTokenCount(o);
}

function sizedObservations(count: number): Observation[] {
	return Array.from({ length: count }, (_, i) => observation(i + 1, ["old"], `fact number ${i + 1} ${"y".repeat(80)}`));
}

describe("selectPriorObservations", () => {
	const observations = sizedObservations(5);
	const perLine = lineTokens(observations[0]);

	it("keeps everything when unlimited", () => {
		const selected = selectPriorObservations(observations, false);
		expect(selected.observations).toEqual(observations);
		expect(selected.omitted).toBe(0);
	});

	it("keeps the newest observations that fit, in chronological order", () => {
		const selected = selectPriorObservations(observations, perLine * 2 + 1);
		expect(selected.observations.map((o) => o.id)).toEqual([observations[3].id, observations[4].id]);
		expect(selected.omitted).toBe(3);
	});

	it("keeps all observations when they fit exactly", () => {
		const total = observations.reduce((sum, o) => sum + lineTokens(o), 0);
		expect(selectPriorObservations(observations, total)).toEqual({ observations, omitted: 0 });
	});

	it("omits all observations at budget 0", () => {
		expect(selectPriorObservations(observations, 0)).toEqual({ observations: [], omitted: 5 });
	});

	it("omits everything when even the newest does not fit", () => {
		expect(selectPriorObservations(observations, perLine - 1)).toEqual({ observations: [], omitted: 5 });
	});

	it("handles an empty list", () => {
		expect(selectPriorObservations([], 0)).toEqual({ observations: [], omitted: 0 });
	});
});

function ledger(observations: Observation[]): Entry[] {
	const stamp = 1_700_000_000_000;
	return [
		{ type: "message", id: "old", message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: stamp } },
		observationsRecordedEntry(observations, "old"),
		{ type: "message", id: "new", message: { role: "user", content: [{ type: "text", text: "fresh backlog" }], timestamp: stamp } },
	];
}

async function observerPrompt(
	branch: Entry[],
	config: Partial<Runtime["config"]>,
	debugEnabled = false,
): Promise<string> {
	const prompts: string[] = [];
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, showWorkerNotifications: false, ...config };
	const ctx: ConsolidationCtx = {
		cwd: "/nonexistent",
		hasUI: false,
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			streamSimple: (_model: unknown, context: Context) => {
				const user = context.messages.find((m) => m.role === "user");
				prompts.push(JSON.stringify(user));
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
					content: [{ type: "text", text: "Done." }], stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		},
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => "s" },
	};
	const pi = { appendEntry: () => undefined } as unknown as ExtensionAPI;
	await withDebugLogContext({ enabled: debugEnabled, sessionId: "prior-cap" }, () => runConsolidationPipeline(pi, runtime, ctx, true));
	return prompts[0];
}

function observationsSection(prompt: string): string {
	const parsed = JSON.parse(prompt) as { content: Array<{ text: string }> };
	const text = parsed.content[0].text;
	const start = text.indexOf("CURRENT OBSERVATIONS:\n") + "CURRENT OBSERVATIONS:\n".length;
	const end = text.indexOf("\n\nCompress the following");
	return text.slice(start, end);
}

describe("observer stage prior-observation cap", () => {
	const observations = sizedObservations(6);
	const perLine = lineTokens(observations[0]);

	it("false sends every observation with no omission line", async () => {
		const section = observationsSection(await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: false }));
		const lines = section.split("\n");
		expect(lines).toHaveLength(6);
		expect(lines[0]).toContain(`[${observations[0].id}]`);
		expect(section).not.toContain("omitted");
	});

	it("default cap leaves small memories untouched", async () => {
		const unlimited = await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: false });
		const capped = await observerPrompt(ledger(observations), {});
		const strip = (p: string) => p.replace(/Current local time: [0-9: -]+/, "").replace(/"timestamp":\d+/, "");
		expect(strip(capped)).toBe(strip(unlimited));
	});

	it("puts the omission line first and keeps the newest observations in order", async () => {
		const section = observationsSection(
			await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: perLine * 2 }),
		);
		const lines = section.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("(4 older observations omitted; only the most recent are shown)");
		expect(lines[1]).toContain(`[${observations[4].id}]`);
		expect(lines[2]).toContain(`[${observations[5].id}]`);
	});

	it("uses singular wording for one omitted observation", async () => {
		const section = observationsSection(
			await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: perLine * 5 }),
		);
		expect(section.split("\n")[0]).toBe("(1 older observation omitted; only the most recent are shown)");
	});

	it("0 omits observations entirely but keeps the notice", async () => {
		const section = observationsSection(await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: 0 }));
		expect(section).toBe("(6 older observations omitted; only the most recent are shown)");
	});

	it("never trims reflections", async () => {
		const reflection = { id: memoryId(900), content: "durable reflection", supportingObservationIds: [observations[0].id], tokenCount: 5 };
		const branch = ledger(observations);
		branch.splice(2, 0, {
			type: "custom",
			id: "refl",
			customType: OM_REFLECTIONS_RECORDED,
			data: { reflections: [reflection], coversUpToId: "old" },
		});
		const prompt = await observerPrompt(branch, { observerPriorObservationsMaxTokens: 0 });
		expect(prompt).toContain("durable reflection");
	});
});

describe("observer.start debug log", () => {
	let root: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-prior-cap-debug-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	function observerStart(): Record<string, unknown> {
		const path = join(root, "observational-memory", "debug", "prior-cap.ndjson");
		expect(existsSync(path)).toBe(true);
		const events = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
		return events.find((event) => event.event === "observer.start")!.data;
	}

	it("records priorObservationsOmitted", async () => {
		const observations = sizedObservations(6);
		await observerPrompt(ledger(observations), { observerPriorObservationsMaxTokens: lineTokens(observations[0]) * 2 }, true);
		expect(observerStart()).toMatchObject({ priorObservationsOmitted: 4, priorObservations: 2, redactedEntries: 0, collapsedEntries: 0 });
	});

	it("records zero when nothing is omitted", async () => {
		await observerPrompt(ledger(sizedObservations(3)), { observerPriorObservationsMaxTokens: false }, true);
		expect(observerStart()).toMatchObject({ priorObservationsOmitted: 0, priorObservations: 3 });
	});
});

describe("observerPriorObservationsMaxTokens config", () => {
	let root: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-prior-cap-config-"));
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
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { observerPriorObservationsMaxTokens: value } }));
		return loadConfig(cwd, {}).observerPriorObservationsMaxTokens;
	}

	it("defaults to 4000", () => {
		expect(DEFAULTS.observerPriorObservationsMaxTokens).toBe(4_000);
		expect(loadConfig(cwd, {}).observerPriorObservationsMaxTokens).toBe(4_000);
	});

	it("accepts non-negative integers and false", () => {
		expect(load(0)).toBe(0);
		expect(load(1500)).toBe(1500);
		expect(load(false)).toBe(false);
	});

	it("falls back to the default for invalid values", () => {
		for (const value of [-1, null, "100", true, 1.5, 12.7]) expect(load(value)).toBe(4_000);
		writeFileSync(join(cwd, ".pi", "settings.json"), '{"observational-memory":{"observerPriorObservationsMaxTokens":NaN}}');
		expect(loadConfig(cwd, {}).observerPriorObservationsMaxTokens).toBe(4_000);
	});
});
