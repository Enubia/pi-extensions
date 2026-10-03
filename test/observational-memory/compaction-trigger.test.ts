import { describe, expect, it, vi } from "vitest";
import {
	compactionProgress,
	isRetryableErrorTurn,
	registerCompactionTrigger,
	RESUME_PROMPT,
	startCompaction,
	turnWillContinue,
} from "../../extensions/observational-memory/src/hooks/compaction-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { OM_RESUME } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { assistantEntry, compactionEntry, text, userEntry } from "./fixtures.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	return {
		pi: {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			sendMessage: vi.fn(),
		},
		emit: (event: string, payload: unknown, ctx: unknown) => handlers.get(event)?.(payload, ctx),
	};
}

function runtimeWith(overrides: Partial<Runtime["config"]> = {}): Runtime {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...runtime.config, compactAfterTokensMode: "calibrated", compactAfterTokens: 1_000, ...overrides };
	return runtime;
}

function fakeCtx(options: { liveTokens?: number | null; contextWindow?: number; selectedWindow?: number; entries?: unknown[]; hasUI?: boolean } = {}) {
	const compact = vi.fn();
	const notify = vi.fn();
	return {
		ctx: {
			cwd: "/tmp",
			hasUI: options.hasUI ?? true,
			ui: { notify },
			model: { contextWindow: options.selectedWindow ?? 200_000 },
			getContextUsage: () => ({ tokens: options.liveTokens ?? null, contextWindow: options.contextWindow }),
			sessionManager: { getBranch: () => options.entries ?? [userEntry("hi")] },
			compact,
		},
		compact,
		notify,
	};
}

function toolTurn() {
	return { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }] };
}

function terminalTurn() {
	return { message: { role: "assistant", stopReason: "stop" }, toolResults: [] };
}

describe("turnWillContinue", () => {
	it("is true when the turn produced tool results", () => {
		expect(turnWillContinue(toolTurn())).toBe(true);
	});

	it("is false for a terminal turn", () => {
		expect(turnWillContinue(terminalTurn())).toBe(false);
	});

	it("falls back to the stop reason when toolResults is missing", () => {
		expect(turnWillContinue({ message: { stopReason: "toolUse" } })).toBe(true);
		expect(turnWillContinue({ message: { stopReason: "stop" } })).toBe(false);
	});
});

describe("isRetryableErrorTurn", () => {
	it("recognises provider errors pi will retry", () => {
		expect(isRetryableErrorTurn({ message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" } })).toBe(true);
	});

	it("ignores ordinary turns and non-retryable errors", () => {
		expect(isRetryableErrorTurn(terminalTurn())).toBe(false);
		expect(isRetryableErrorTurn({ message: { role: "assistant", stopReason: "error", errorMessage: "invalid api key" } })).toBe(false);
	});
});

describe("compactionProgress", () => {
	it("uses live usage growth since the last compaction when measurable", () => {
		const kept = userEntry("kept");
		const entries = [userEntry(text(500)), compactionEntry(kept.id), kept, assistantEntry("a", { usageTokens: 10_000 }), userEntry(text(50))];
		expect(compactionProgress(entries, 12_500)).toBe(2_500);
	});

	it("falls back to the raw estimate when live usage is unknown", () => {
		const entries = [userEntry(text(100)), assistantEntry(text(100))];
		expect(compactionProgress(entries, null)).toBeGreaterThanOrEqual(200);
	});

	it("falls back to the raw estimate when the live baseline is unusable", () => {
		const kept = userEntry("kept");
		const entries = [compactionEntry(kept.id), kept, assistantEntry("a", { usageTokens: 10_000 }), userEntry(text(100))];
		expect(compactionProgress(entries, 5_000)).toBe(compactionProgress(entries, null));
	});
});

describe("registerCompactionTrigger", () => {
	it("ratio mode compacts against the routed physical window instead of the larger virtual window", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith({ compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }));
		const { ctx, compact, notify } = fakeCtx({ liveTokens: 80_000, contextWindow: 128_000, selectedWindow: 1_000_000 });
		emit("turn_end", terminalTurn(), ctx);
		expect(compact).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("80,000 / 64,000 tokens");
	});

	it.each([
		{ effective: 1_000_000, selected: 128_000, tokens: 80_000, expected: false },
		{ effective: 200_000, selected: 200_000, tokens: 99_999, expected: false },
		{ effective: 200_000, selected: 200_000, tokens: 100_000, expected: true },
		...[undefined, 0, -1, NaN, Infinity, -Infinity].map(effective => ({ effective, selected: 200_000, tokens: 100_000, expected: true })),
		...[0, -1, NaN, Infinity, -Infinity].map(selected => ({ effective: NaN, selected, tokens: 1_000, expected: true })),
	])("ratio window fallback and physical boundary: $effective/$selected at $tokens", ({ effective, selected, tokens, expected }) => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith({ compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }));
		const { ctx, compact } = fakeCtx({ liveTokens: tokens, contextWindow: effective, selectedWindow: selected });
		emit("turn_end", terminalTurn(), ctx);
		expect(compact).toHaveBeenCalledTimes(expected ? 1 : 0);
	});

	it("uses a known effective window even while the token count is unknown", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith({ compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }));
		const { ctx, compact } = fakeCtx({ entries: [userEntry(text(80_000))], contextWindow: 128_000, selectedWindow: 1_000_000 });
		emit("turn_end", terminalTurn(), ctx);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("falls back to selected limits and raw progress when the host provides no usage", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith({ compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }));
		const { ctx, compact } = fakeCtx({ entries: [userEntry(text(80_000))], selectedWindow: 128_000 });
		emit("turn_end", terminalTurn(), { ...ctx, getContextUsage: undefined });
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("uses the configured threshold when neither usage nor a selected model is available", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith({ compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 }));
		const { ctx, compact } = fakeCtx({ entries: [userEntry(text(1_000))] });
		emit("turn_end", terminalTurn(), { ...ctx, model: undefined, getContextUsage: () => undefined });
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("calibrated mode ignores virtual and physical windows", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ liveTokens: 1_000, contextWindow: 1_000_000, selectedWindow: 128_000 });
		emit("turn_end", terminalTurn(), ctx);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("compacts on turn_end once live progress crosses the threshold and resumes a mid-run turn", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);

		expect(compact).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);

		compact.mock.calls[0][0].onComplete();
		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			{ customType: OM_RESUME, content: RESUME_PROMPT, display: false },
			{ triggerTurn: true },
		);
	});

	it("does not resume after compacting a terminal turn", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", terminalTurn(), ctx);
		compact.mock.calls[0][0].onComplete();

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not resume when resumeAfterMidRunCompaction is off", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith({ resumeAfterMidRunCompaction: false });
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);
		compact.mock.calls[0][0].onComplete();

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("stays quiet below the threshold", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ liveTokens: 500 });

		emit("turn_end", toolTurn(), ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("skips turns pi will retry itself", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", { message: { role: "assistant", stopReason: "error", errorMessage: "503 service unavailable" }, toolResults: [] }, ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("never double-fires while a compaction is in flight", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);
		emit("turn_end", toolTurn(), ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("is inert when the session gate is off or passive mode is set", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		runtime.enabled = false;
		emit("turn_end", toolTurn(), ctx);
		runtime.enabled = true;
		runtime.config.passive = true;
		emit("turn_end", toolTurn(), ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("never compacts mid-run in headless mode because the process exits at agent_end", () => {
		const { pi, emit } = fakePi();
		registerCompactionTrigger(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000, hasUI: false });

		emit("turn_end", toolTurn(), ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("still resumes the aborted run when compaction fails, and suspends auto-compaction", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);
		compact.mock.calls[0][0].onError({ message: "Nothing to compact (session too small)" });

		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.autoCompactSuspended).toBe("Nothing to compact (session too small)");
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		emit("turn_end", toolTurn(), ctx);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not resume or suspend when a duplicate compaction is cancelled", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);
		compact.mock.calls[0][0].onError({ message: "Compaction cancelled" });

		expect(runtime.autoCompactSuspended).toBeUndefined();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("a successful compaction lifts the suspension", () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		runtime.autoCompactSuspended = "earlier failure";
		registerCompactionTrigger(pi as never, runtime);
		const { ctx, compact } = fakeCtx({ liveTokens: 5_000 });

		emit("turn_end", toolTurn(), ctx);
		expect(compact).not.toHaveBeenCalled();

		startCompaction(pi as never, runtime, ctx as never, { shouldResume: false });
		compact.mock.calls[0][0].onComplete();
		expect(runtime.autoCompactSuspended).toBeUndefined();
	});
});
