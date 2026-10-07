import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { runObserver } from "../../extensions/observational-memory/src/agents/observer/agent.js";
import { OBSERVER_SYSTEM } from "../../extensions/observational-memory/src/agents/observer/prompts.js";
import type { WorkerStreamSimple } from "../../extensions/observational-memory/src/agents/worker-stream.js";
import { DEFAULTS } from "../../extensions/observational-memory/src/config.js";
import { registerCompactionHook } from "../../extensions/observational-memory/src/hooks/compaction-hook.js";
import { RESUME_PROMPT, startCompaction } from "../../extensions/observational-memory/src/hooks/compaction-trigger.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { MAX_RECORD_CONTENT_CHARS } from "../../extensions/observational-memory/src/serialize.js";
import {
	OM_FOLDED,
	OM_OBSERVATIONS_RECORDED,
	OM_RESUME,
	buildCompactionProjection,
	isMemoryDetails,
	isObservationsRecordedData,
	renderSummary,
	type Entry,
} from "../../extensions/observational-memory/src/session-ledger/index.js";
import { assistantEntry, observation, observationsRecordedEntry, text, toolResultEntry, userEntry } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const HINT = { content: "Finish the merger wiring; next run the full suite.", timestamp: "2026-02-02 09:30" };

type ToolArgs = Record<string, unknown>;

function toolCall(args: ToolArgs, id = "call-1") {
	return { type: "toolCall" as const, id, name: "record_observations", arguments: args as Record<string, never> };
}

function batch(extra: ToolArgs = {}, content = "Synthetic fact.") {
	return {
		observations: [{ timestamp: "2030-01-01 10:00", content, relevance: "medium", sourceEntryIds: ["entry-1"] }],
		...extra,
	};
}

function scripted(calls: ToolArgs[]): WorkerStreamSimple {
	let request = 0;
	return () => {
		const index = request++;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: index < calls.length ? [toolCall(calls[index], `call-${index}`)] : [{ type: "text", text: "Done." }],
			stopReason: index < calls.length ? "toolUse" : "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		return stream;
	};
}

function observe(calls: ToolArgs[]) {
	return runObserver({
		model,
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-1] Synthetic facts.",
		allowedSourceEntryIds: ["entry-1"],
		streamSimple: scripted(calls),
	});
}

describe("observer current task capture", () => {
	it("captures the hint with an observation-format timestamp", async () => {
		const result = await observe([batch({ currentTask: "Wire the merger; next run tests." })]);
		expect(result?.observations).toHaveLength(1);
		expect(result?.currentTask?.content).toBe("Wire the merger; next run tests.");
		expect(result?.currentTask?.timestamp).toMatch(TIMESTAMP_PATTERN);
	});

	it("stores nothing when the tool omits the hint", async () => {
		const result = await observe([batch()]);
		expect(result?.observations).toHaveLength(1);
		expect(result?.currentTask).toBeUndefined();
	});

	it.each(["", "   \n\t "])("stores nothing for blank hint %j", async (blank) => {
		const result = await observe([batch({ currentTask: blank })]);
		expect(result?.currentTask).toBeUndefined();
	});

	it("truncates the hint like observation content", async () => {
		const long = "g".repeat(MAX_RECORD_CONTENT_CHARS + 25);
		const result = await observe([batch({ currentTask: long })]);
		expect(result?.currentTask?.content).toBe(`${"g".repeat(MAX_RECORD_CONTENT_CHARS)} … [truncated 25 chars]`);
	});

	it("keeps the latest provided hint across calls and ignores later omissions", async () => {
		const result = await observe([
			batch({ currentTask: "First task." }, "Fact one."),
			batch({ currentTask: "Second task." }, "Fact two."),
			batch({}, "Fact three."),
		]);
		expect(result?.observations).toHaveLength(3);
		expect(result?.currentTask?.content).toBe("Second task.");
	});

	it("collapses a multi-line hint to a single line", async () => {
		const result = await observe([batch({ currentTask: "Goal: ship.\nNext: test." })]);
		expect(result?.currentTask?.content).toBe("Goal: ship. Next: test.");
	});

	it("documents the hint in the observer prompt", () => {
		expect(OBSERVER_SYSTEM).toContain("currentTask");
	});
});

describe("observer stage persists the hint", () => {
	async function appended(calls: ToolArgs[]) {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, showWorkerNotifications: false };
		const u1 = userEntry("start working");
		const branch: Entry[] = [u1];
		const ctx: ConsolidationCtx = {
			cwd: "/nonexistent",
			hasUI: false,
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
				streamSimple: scripted(calls.map((call) => ({
					...call,
					observations: [{ timestamp: "2030-01-01 10:00", content: "Synthetic fact.", relevance: "medium", sourceEntryIds: [u1.id] }],
				}))),
			},
			sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => "s" },
		};
		const appendEntry = vi.fn();
		await runConsolidationPipeline({ appendEntry } as unknown as ExtensionAPI, runtime, ctx, true);
		return appendEntry.mock.calls.filter(([type]) => type === OM_OBSERVATIONS_RECORDED).map(([, data]) => data);
	}

	it("writes currentTask onto the observations entry", async () => {
		const [data] = await appended([{ currentTask: "Continue the migration." }]);
		expect(isObservationsRecordedData(data)).toBe(true);
		expect(data.currentTask.content).toBe("Continue the migration.");
		expect(data.currentTask.timestamp).toMatch(TIMESTAMP_PATTERN);
	});

	it("writes no currentTask key when the hint is absent", async () => {
		const [data] = await appended([{}]);
		expect(data).not.toHaveProperty("currentTask");
	});
});

describe("ledger validators", () => {
	const base = { observations: [observation(1, ["a"])], coversUpToId: "a" };

	it("accepts entries with and without a hint", () => {
		expect(isObservationsRecordedData(base)).toBe(true);
		expect(isObservationsRecordedData({ ...base, currentTask: HINT })).toBe(true);
	});

	it("rejects malformed hints", () => {
		expect(isObservationsRecordedData({ ...base, currentTask: { content: "", timestamp: "t" } })).toBe(false);
		expect(isObservationsRecordedData({ ...base, currentTask: "text" })).toBe(false);
	});

	it("accepts folded details with an optional hint", () => {
		const details = { type: OM_FOLDED, version: 1, fullFold: false, observations: [], reflections: [] };
		expect(isMemoryDetails(details)).toBe(true);
		expect(isMemoryDetails({ ...details, currentTask: HINT })).toBe(true);
		expect(isMemoryDetails({ ...details, currentTask: { content: 1 } })).toBe(false);
	});
});

describe("renderSummary current task", () => {
	const observations = [observation(1, ["a"])];

	it("is byte-identical without a hint", () => {
		expect(renderSummary([], observations, undefined)).toBe(renderSummary([], observations));
		expect(renderSummary([], observations)).not.toContain("Current task");
	});

	it("renders the section after observations", () => {
		const summary = renderSummary([], observations, HINT);
		expect(summary.endsWith(`\n\n## Current task (as of 2026-02-02 09:30)\n${HINT.content}`)).toBe(true);
		expect(summary.indexOf("## Observations")).toBeLessThan(summary.indexOf("## Current task"));
	});
});

describe("compaction projection hint selection", () => {
	function chunks() {
		const u1 = userEntry(text(100));
		const a1 = assistantEntry(text(100));
		const u2 = userEntry(text(100));
		const a2 = assistantEntry(text(100));
		const u3 = userEntry(text(50));
		const a3 = assistantEntry(text(50));
		const older = { content: "Older task.", timestamp: "2026-02-01 08:00" };
		const chunk1 = observationsRecordedEntry([observation(1, [u1.id, a1.id])], a1.id, undefined, older);
		const chunk2 = observationsRecordedEntry([observation(2, [u2.id, a2.id])], a2.id, undefined, HINT);
		return { u1, a1, u2, a2, u3, a3, chunk1, chunk2, entries: [u1, a1, chunk1, u2, a2, chunk2, u3, a3] };
	}
	const config = { observationsPoolMaxTokens: 1_000_000 };

	it("takes the hint from the entry covering the snapped boundary", () => {
		const c = chunks();
		const projection = buildCompactionProjection(c.entries, c.u3.id, config);
		expect(projection.currentTask).toEqual(HINT);
		expect(projection.details.currentTask).toEqual(HINT);
		expect(isMemoryDetails(projection.details)).toBe(true);
		expect(projection.details.version).toBe(1);
	});

	it("selects the earlier boundary's own hint, not the newest", () => {
		const c = chunks();
		const projection = buildCompactionProjection(c.entries, c.u2.id, config);
		expect(projection.currentTask).toEqual({ content: "Older task.", timestamp: "2026-02-01 08:00" });
	});

	it("omits the hint when the boundary entry has none, never falling back", () => {
		const c = chunks();
		const bare = observationsRecordedEntry([observation(2, [c.u2.id, c.a2.id])], c.a2.id);
		const projection = buildCompactionProjection([c.u1, c.a1, c.chunk1, c.u2, c.a2, bare, c.u3, c.a3], c.u3.id, config);
		expect(projection.currentTask).toBeUndefined();
		expect(projection.details).not.toHaveProperty("currentTask");
	});

	it("omits the hint when the cut is not at a chunk boundary", () => {
		const c = chunks();
		const projection = buildCompactionProjection(c.entries, c.a3.id, config);
		expect(projection.currentTask).toBeUndefined();
	});

	it("uses the latest entry when several cover the same boundary", () => {
		const c = chunks();
		const newer = { content: "Newer same-boundary task.", timestamp: "2026-02-03 10:00" };
		const dup = observationsRecordedEntry([observation(3, [c.a2.id])], c.a2.id, undefined, newer);
		const projection = buildCompactionProjection([c.u1, c.a1, c.chunk1, c.u2, c.a2, c.chunk2, dup, c.u3, c.a3], c.u3.id, config);
		expect(projection.currentTask).toEqual(newer);
	});

	it("rejects a malformed hint instead of rendering it", () => {
		const c = chunks();
		const bad = { type: "custom", id: "bad", customType: OM_OBSERVATIONS_RECORDED, data: { observations: [observation(2, [c.u2.id])], coversUpToId: c.a2.id, currentTask: { content: 5 } } } as Entry;
		const projection = buildCompactionProjection([c.u1, c.a1, c.chunk1, c.u2, c.a2, bad, c.u3, c.a3], c.u3.id, config);
		expect(projection.currentTask).toBeUndefined();
	});
});

describe("compaction hook hint", () => {
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

	async function compact(entries: Entry[], firstKeptEntryId: string) {
		const handlers = new Map<string, Handler>();
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...runtime.config, tailTokens: 100 };
		registerCompactionHook({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never, runtime);
		const ctx = { cwd: "/tmp", hasUI: false, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => entries } };
		return await handlers.get("session_before_compact")!(
			{ preparation: { firstKeptEntryId, tokensBefore: 1_000 }, branchEntries: entries },
			ctx,
		) as { compaction: { summary: string; details: { currentTask?: unknown } } };
	}

	function branch(withHint: boolean) {
		const u1 = userEntry(text(100));
		const a1 = assistantEntry(text(100));
		const u2 = userEntry(text(100));
		const chunk = observationsRecordedEntry([observation(1, [u1.id, a1.id])], a1.id, undefined, withHint ? HINT : undefined);
		return { entries: [u1, a1, chunk, u2], u2, a1 };
	}

	it("renders and records the hint when the snapped cut sits on the boundary", async () => {
		const b = branch(true);
		const { compaction } = await compact(b.entries, b.u2.id);
		expect(compaction.summary).toContain(`## Current task (as of ${HINT.timestamp})\n${HINT.content}`);
		expect(compaction.details.currentTask).toEqual(HINT);
	});

	it("renders no hint section without one", async () => {
		const b = branch(false);
		const { compaction } = await compact(b.entries, b.u2.id);
		expect(compaction.summary).not.toContain("Current task");
		expect(compaction.details).not.toHaveProperty("currentTask");
	});

	it("renders no hint when snapping falls back to the proposed cut", async () => {
		const u1 = userEntry(text(100));
		const a1 = assistantEntry(text(10), { stopReason: "toolUse" });
		const t1 = toolResultEntry(text(100));
		const a2 = assistantEntry(text(10));
		const chunk = observationsRecordedEntry([observation(1, [u1.id, a1.id])], a1.id, undefined, HINT);
		const { compaction } = await compact([u1, a1, chunk, t1, a2], t1.id);
		expect(compaction.summary).not.toContain("Current task");
		expect(compaction.details).not.toHaveProperty("currentTask");
	});
});

describe("resume prompt", () => {
	function compactionWith(details: unknown): Entry {
		return { type: "compaction", id: "cmp", firstKeptEntryId: "u", summary: "s", details };
	}
	const folded = (extra: object = {}) => ({ type: OM_FOLDED, version: 1, fullFold: false, observations: [], reflections: [], ...extra });

	function resumeContent(entries: Entry[]): string {
		const sendMessage = vi.fn();
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const compact = vi.fn();
		startCompaction({ sendMessage } as never, runtime, {
			cwd: "/tmp",
			hasUI: false,
			sessionManager: { getBranch: () => entries },
			compact,
		}, { shouldResume: true });
		compact.mock.calls[0][0].onComplete();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0][0].customType).toBe(OM_RESUME);
		return sendMessage.mock.calls[0][0].content;
	}

	it("keeps the hint-less text unchanged", () => {
		expect(resumeContent([compactionWith(folded())])).toBe(RESUME_PROMPT);
		expect(RESUME_PROMPT).toBe(
			"[automatic] Your context was just compacted to free space; no user message was sent. "
			+ "Continue exactly where you left off, as if the compaction had not happened.",
		);
	});

	it("mentions the current task in memory when the latest compaction carries one", () => {
		const content = resumeContent([compactionWith(folded({ currentTask: HINT }))]);
		expect(content).toContain(RESUME_PROMPT);
		expect(content).toContain("current task");
		expect(content).toContain("## Current task");
	});

	it("ignores a hint on an older compaction", () => {
		const older = { ...compactionWith(folded({ currentTask: HINT })), id: "old" };
		const latest = compactionWith(folded());
		expect(resumeContent([older, latest])).toBe(RESUME_PROMPT);
	});

	it("falls back to the plain prompt when the branch is unavailable", () => {
		expect(resumeContent([])).toBe(RESUME_PROMPT);
	});
});
