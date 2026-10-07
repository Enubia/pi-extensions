import { describe, expect, it, vi } from "vitest";
import {
	cachePolicyTtlMs,
	lastAssistantTimestamp,
	registerCacheAwareCompaction,
} from "../../extensions/observational-memory/src/hooks/cache-aware-compaction.js";
import { compactionProgress, registerCompactionTrigger, startCompaction } from "../../extensions/observational-memory/src/hooks/compaction-trigger.js";
import { DEFAULTS, type CacheAwareCompactionConfig } from "../../extensions/observational-memory/src/config.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { assistantEntry, text, userEntry } from "./fixtures.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	return {
		pi: { on: (event: string, handler: Handler) => handlers.set(event, handler), sendMessage: vi.fn() },
		emit: (event: string, payload: unknown, ctx: unknown) => handlers.get(event)?.(payload, ctx),
		registered: () => [...handlers.keys()],
	};
}

const HARD = 1_000;
const SOFT = 600;

function runtimeWith(cache: Partial<CacheAwareCompactionConfig> = {}, overrides: Partial<Runtime["config"]> = {}): Runtime {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		compactAfterTokensMode: "calibrated",
		compactAfterTokens: HARD,
		cacheAwareCompaction: { ...DEFAULTS.cacheAwareCompaction, ...cache },
		...overrides,
	};
	return runtime;
}

const MIN = 60_000;

function entriesAt(ageMs: number, progressTokens: number, now: number) {
	const assistant = assistantEntry("done");
	(assistant as { message: { timestamp: number } }).message.timestamp = now - ageMs;
	const overhead = compactionProgress([assistant], null);
	return [userEntry(text(progressTokens - overhead)), assistant];
}

function fakeCtx(options: {
	now?: number;
	ageMs?: number;
	progress?: number;
	promptCache?: { short?: number; long?: number } | undefined;
	hasUI?: boolean;
	entries?: unknown[];
	compactImpl?: "complete" | "error" | "throw" | "manual";
} = {}) {
	const now = options.now ?? Date.now();
	const progress = options.progress ?? SOFT + 100;
	const entries = options.entries ?? entriesAt(options.ageMs ?? 1_000, progress, now);
	const pending: { complete?: () => void; fail?: (message: string) => void } = {};
	const compact = vi.fn((opts: { onComplete?: () => void; onError?: (e: { message: string }) => void }) => {
		const mode = options.compactImpl ?? "complete";
		if (mode === "throw") throw new Error("boom");
		if (mode === "manual") {
			pending.complete = () => opts.onComplete?.();
			pending.fail = (message) => opts.onError?.({ message });
			return;
		}
		if (mode === "error") opts.onError?.({ message: "compaction failed" });
		else opts.onComplete?.();
	});
	const notify = vi.fn();
	return {
		ctx: {
			cwd: "/tmp",
			hasUI: options.hasUI ?? true,
			ui: { notify },
			model: { provider: "anthropic", id: "m", contextWindow: 200_000, promptCache: "promptCache" in options ? options.promptCache : { short: 300 } },
			getContextUsage: () => ({ tokens: null, contextWindow: undefined }),
			sessionManager: { getBranch: () => entries },
			compact,
		},
		compact,
		notify,
		pending,
		now,
	};
}

function modelSelect(provider: string, id: string, previous?: { provider: string; id: string }) {
	return { type: "model_select", model: { provider, id }, previousModel: previous, source: "set" };
}

function beforeStart(prompt = "hi") {
	return { type: "before_agent_start", prompt, images: [{ type: "image" }] };
}

describe("cachePolicyTtlMs", () => {
	it("reads the declared short lifetime in milliseconds", () => {
		expect(cachePolicyTtlMs({ promptCache: { short: 300 } })).toBe(300_000);
	});

	it.each([undefined, {}, { long: 3600 }, { short: 0 }, { short: -1 }, { short: Number.NaN }])("is unknown for %j", (promptCache) => {
		expect(cachePolicyTtlMs({ promptCache } as never)).toBeUndefined();
		expect(cachePolicyTtlMs(undefined)).toBeUndefined();
	});
});

describe("lastAssistantTimestamp", () => {
	it("returns the newest assistant message timestamp", () => {
		const a = assistantEntry("a");
		(a as { message: { timestamp: number } }).message.timestamp = 10;
		const b = assistantEntry("b");
		(b as { message: { timestamp: number } }).message.timestamp = 20;
		expect(lastAssistantTimestamp([a, userEntry("u"), b, userEntry("v")])).toBe(20);
	});

	it("is undefined without assistant messages", () => {
		expect(lastAssistantTimestamp([userEntry("u")])).toBeUndefined();
	});
});

describe("before_agent_start cache-aware compaction", () => {
	it("compacts before the request after an idle gap longer than the TTL and waits for completion", async () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCacheAwareCompaction(pi as never, runtime);
		const { ctx, compact, pending } = fakeCtx({ ageMs: 6 * MIN, compactImpl: "manual" });
		let settled = false;
		const result = Promise.resolve(emit("before_agent_start", beforeStart(), ctx)).then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		expect(runtime.compactInFlight).toBe(true);
		pending.complete!();
		await result;
		expect(settled).toBe(true);
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.lastColdSignal?.reason).toBe("idle");
		await expect(result).resolves.toBeUndefined();
	});

	it("does not resume the run after the pre-request compaction", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx } = fakeCtx({ ageMs: 6 * MIN });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not compact when the cache is still warm", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ ageMs: 4 * MIN });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("does not compact below the soft threshold even when cold", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ ageMs: 6 * MIN, progress: SOFT - 50 });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("compacts at exactly the soft threshold", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ ageMs: 6 * MIN, progress: SOFT });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("derives soft from softFraction with floor", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith({ softFraction: 0.5 }));
		const below = fakeCtx({ ageMs: 6 * MIN, progress: 499 });
		await emit("before_agent_start", beforeStart(), below.ctx);
		expect(below.compact).not.toHaveBeenCalled();
		const at = fakeCtx({ ageMs: 6 * MIN, progress: 500 });
		await emit("before_agent_start", beforeStart(), at.ctx);
		expect(at.compact).toHaveBeenCalledTimes(1);
	});

	it("never takes the idle path when the TTL is unknown", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		for (const promptCache of [undefined, {}, { long: 3600 }]) {
			const { ctx, compact } = fakeCtx({ ageMs: 24 * 60 * MIN, promptCache });
			await emit("before_agent_start", beforeStart(), ctx);
			expect(compact).not.toHaveBeenCalled();
		}
	});

	it("uses an explicit idle seconds value even without a declared TTL", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith({ idle: 120 }));
		const cold = fakeCtx({ ageMs: 3 * MIN, promptCache: undefined });
		await emit("before_agent_start", beforeStart(), cold.ctx);
		expect(cold.compact).toHaveBeenCalledTimes(1);
		const warm = fakeCtx({ ageMs: MIN, promptCache: undefined });
		await emit("before_agent_start", beforeStart(), warm.ctx);
		expect(warm.compact).not.toHaveBeenCalled();
	});

	it("skips the idle signal when idle is false", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith({ idle: false }));
		const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("does nothing when disabled", async () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith({ enabled: false });
		registerCacheAwareCompaction(pi as never, runtime);
		emit("model_select", modelSelect("openai", "gpt", { provider: "anthropic", id: "m" }), fakeCtx().ctx);
		const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
		expect(runtime.cacheColdReason).toBeUndefined();
	});

	it("does nothing when OM is passive, off, or has no UI", async () => {
		for (const setup of [
			(runtime: Runtime) => { runtime.config = { ...runtime.config, passive: true }; },
			(runtime: Runtime) => { runtime.enabled = false; },
		]) {
			const { pi, emit } = fakePi();
			const runtime = runtimeWith();
			setup(runtime);
			registerCacheAwareCompaction(pi as never, runtime);
			const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN });
			await emit("before_agent_start", beforeStart(), ctx);
			expect(compact).not.toHaveBeenCalled();
		}
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN, hasUI: false });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("compacts before the next request after a provider or id model switch", async () => {
		for (const [next, previous] of [
			[{ provider: "openai", id: "m" }, { provider: "anthropic", id: "m" }],
			[{ provider: "anthropic", id: "n" }, { provider: "anthropic", id: "m" }],
		]) {
			const { pi, emit } = fakePi();
			const runtime = runtimeWith();
			registerCacheAwareCompaction(pi as never, runtime);
			emit("model_select", modelSelect(next.provider, next.id, previous), fakeCtx().ctx);
			expect(runtime.cacheColdReason).toBe("model-change");
			const { ctx, compact } = fakeCtx({ ageMs: 1_000 });
			await emit("before_agent_start", beforeStart(), ctx);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(runtime.cacheColdReason).toBeUndefined();
			expect(runtime.lastColdSignal?.reason).toBe("model-change");
		}
	});

	it("ignores model_select without a different previous model or when onModelChange is off", async () => {
		const same = fakePi();
		const sameRuntime = runtimeWith();
		registerCacheAwareCompaction(same.pi as never, sameRuntime);
		same.emit("model_select", modelSelect("a", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
		same.emit("model_select", modelSelect("a", "m", undefined), fakeCtx().ctx);
		expect(sameRuntime.cacheColdReason).toBeUndefined();

		const off = fakePi();
		const offRuntime = runtimeWith({ onModelChange: false });
		registerCacheAwareCompaction(off.pi as never, offRuntime);
		off.emit("model_select", modelSelect("b", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
		expect(offRuntime.cacheColdReason).toBeUndefined();
	});

	it("does not force compaction after a model switch when below the soft threshold", async () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCacheAwareCompaction(pi as never, runtime);
		emit("model_select", modelSelect("b", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
		const { ctx, compact } = fakeCtx({ progress: SOFT - 100 });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
		expect(runtime.cacheColdReason).toBeUndefined();
	});

	it("consumes the model-change flag so the following request does not compact again", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		emit("model_select", modelSelect("b", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
		const first = fakeCtx({ ageMs: 1_000 });
		await emit("before_agent_start", beforeStart(), first.ctx);
		const second = fakeCtx({ ageMs: 1_000 });
		await emit("before_agent_start", beforeStart(), second.ctx);
		expect(first.compact).toHaveBeenCalledTimes(1);
		expect(second.compact).not.toHaveBeenCalled();
	});

	it("does not start a second compaction while one is in flight or auto-compaction is suspended", async () => {
		for (const setup of [
			(runtime: Runtime) => { runtime.compactInFlight = true; },
			(runtime: Runtime) => { runtime.autoCompactSuspended = "failed"; },
		]) {
			const { pi, emit } = fakePi();
			const runtime = runtimeWith();
			setup(runtime);
			registerCacheAwareCompaction(pi as never, runtime);
			const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN });
			await emit("before_agent_start", beforeStart(), ctx);
			expect(compact).not.toHaveBeenCalled();
		}
	});

	it("keeps the model-change flag while a compaction is in flight or auto-compaction is suspended", async () => {
		for (const [block, release] of [
			[(runtime: Runtime) => { runtime.compactInFlight = true; }, (runtime: Runtime) => { runtime.compactInFlight = false; }],
			[(runtime: Runtime) => { runtime.autoCompactSuspended = "failed"; }, (runtime: Runtime) => { runtime.autoCompactSuspended = undefined; }],
		] as const) {
			const { pi, emit } = fakePi();
			const runtime = runtimeWith();
			registerCacheAwareCompaction(pi as never, runtime);
			emit("model_select", modelSelect("b", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
			block(runtime);
			const blocked = fakeCtx({ ageMs: 1_000 });
			await emit("before_agent_start", beforeStart(), blocked.ctx);
			expect(blocked.compact).not.toHaveBeenCalled();
			expect(runtime.cacheColdReason).toBe("model-change");
			release(runtime);
			const next = fakeCtx({ ageMs: 1_000 });
			await emit("before_agent_start", beforeStart(), next.ctx);
			expect(next.compact).toHaveBeenCalledTimes(1);
			expect(runtime.cacheColdReason).toBeUndefined();
			expect(runtime.lastColdSignal?.reason).toBe("model-change");
		}
	});

	it("does not wait on in-flight consolidation: skips this prompt and keeps the cold signal for the next", async () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCacheAwareCompaction(pi as never, runtime);
		emit("model_select", modelSelect("b", "m", { provider: "a", id: "m" }), fakeCtx().ctx);
		runtime.consolidationInFlight = true;
		const blocked = fakeCtx({ ageMs: 1_000 });
		await emit("before_agent_start", beforeStart(), blocked.ctx);
		expect(blocked.compact).not.toHaveBeenCalled();
		expect(runtime.cacheColdReason).toBe("model-change");
		expect(runtime.lastColdSignal).toBeUndefined();
		runtime.consolidationInFlight = false;
		const next = fakeCtx({ ageMs: 1_000 });
		await emit("before_agent_start", beforeStart(), next.ctx);
		expect(next.compact).toHaveBeenCalledTimes(1);
		expect(runtime.lastColdSignal?.reason).toBe("model-change");
	});

	it("retries an idle-cold prompt once consolidation has finished", async () => {
		const { pi, emit } = fakePi();
		const runtime = runtimeWith();
		registerCacheAwareCompaction(pi as never, runtime);
		runtime.consolidationInFlight = true;
		const blocked = fakeCtx({ ageMs: 6 * MIN });
		await emit("before_agent_start", beforeStart(), blocked.ctx);
		expect(blocked.compact).not.toHaveBeenCalled();
		runtime.consolidationInFlight = false;
		const next = fakeCtx({ ageMs: 6 * MIN });
		await emit("before_agent_start", beforeStart(), next.ctx);
		expect(next.compact).toHaveBeenCalledTimes(1);
		expect(runtime.lastColdSignal?.reason).toBe("idle");
	});

	it("lets the prompt continue when compaction errors or throws", async () => {
		for (const compactImpl of ["error", "throw"] as const) {
			const { pi, emit } = fakePi();
			const runtime = runtimeWith();
			registerCacheAwareCompaction(pi as never, runtime);
			const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN, compactImpl });
			await expect(Promise.resolve(emit("before_agent_start", beforeStart(), ctx))).resolves.toBeUndefined();
			expect(compact).toHaveBeenCalledTimes(1);
			expect(runtime.compactInFlight).toBe(false);
			expect(runtime.autoCompactSuspended).toBeUndefined();
		}
	});

	it("never alters or consumes the prompt and attachments", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx } = fakeCtx({ ageMs: 60 * MIN });
		const event = beforeStart("keep me");
		const snapshot = JSON.stringify(event);
		const result = await emit("before_agent_start", event, ctx);
		expect(result).toBeUndefined();
		expect(JSON.stringify(event)).toBe(snapshot);
	});

	it("reports the cache-cold reason in the notification", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx, notify } = fakeCtx({ ageMs: 6 * MIN, progress: 700 });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(String(notify.mock.calls[0][0])).toContain("prompt cache cold (idle)");
		expect(String(notify.mock.calls[0][0])).toContain("~700 tokens");
	});
});

describe("cache_warming_decision", () => {
	function decision(action: "warm" | "stop") {
		return { type: "cache_warming_decision", warmCost: 0.01, missCost: 0.5, continuationProbability: 0.2, action };
	}

	it("returns stop once progress reaches the soft threshold", () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx } = fakeCtx({ progress: SOFT });
		expect(emit("cache_warming_decision", decision("warm"), ctx)).toEqual({ action: "stop" });
	});

	it("leaves Pi's decision alone below the soft threshold", () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const { ctx } = fakeCtx({ progress: SOFT - 100 });
		expect(emit("cache_warming_decision", decision("warm"), ctx)).toBeUndefined();
	});

	it("does not interfere when disabled", () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith({ enabled: false }));
		const { ctx } = fakeCtx({ progress: HARD });
		expect(emit("cache_warming_decision", decision("warm"), ctx)).toBeUndefined();
	});

	it("keeps the cache warm for the idle clock while warm decisions arrive", async () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		const first = fakeCtx({ progress: SOFT - 100 });
		emit("cache_warming_decision", decision("warm"), first.ctx);
		const { ctx, compact } = fakeCtx({ ageMs: 60 * MIN });
		await emit("before_agent_start", beforeStart(), ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("marks the cache as expiring one TTL after a stop decision", async () => {
		vi.useFakeTimers();
		try {
			const start = new Date("2026-01-01T00:00:00Z").getTime();
			vi.setSystemTime(start);
			const { pi, emit } = fakePi();
			registerCacheAwareCompaction(pi as never, runtimeWith());
			const stopCtx = fakeCtx({ now: start, ageMs: 0, progress: SOFT - 100 });
			emit("cache_warming_decision", decision("stop"), stopCtx.ctx);

			vi.setSystemTime(start + 4 * MIN);
			const early = fakeCtx({ now: start + 4 * MIN, ageMs: 60 * MIN });
			await emit("before_agent_start", beforeStart(), early.ctx);
			expect(early.compact).not.toHaveBeenCalled();

			vi.setSystemTime(start + 6 * MIN);
			const late = fakeCtx({ now: start + 6 * MIN, ageMs: 60 * MIN });
			await emit("before_agent_start", beforeStart(), late.ctx);
			expect(late.compact).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves warming alone when the idle signal is off", () => {
		const { pi, emit } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith({ idle: false }));
		const { ctx } = fakeCtx({ progress: HARD });
		expect(emit("cache_warming_decision", decision("warm"), ctx)).toBeUndefined();
	});

	it("registers every hook it needs", () => {
		const { pi, registered } = fakePi();
		registerCacheAwareCompaction(pi as never, runtimeWith());
		expect(registered().sort()).toEqual(["before_agent_start", "cache_warming_decision", "model_select"]);
	});
});

describe("coexistence with the hard threshold trigger", () => {
	function bothRegistered(runtime: Runtime) {
		const turnEnd = fakePi();
		registerCompactionTrigger(turnEnd.pi as never, runtime);
		const cache = fakePi();
		registerCacheAwareCompaction(cache.pi as never, runtime);
		return { turnEnd, cache };
	}

	const toolTurn = { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }] };

	it("never compacts mid-run between soft and hard", () => {
		const { turnEnd } = bothRegistered(runtimeWith());
		const { ctx, compact } = fakeCtx({ progress: HARD - 1, ageMs: 60 * MIN });
		turnEnd.emit("turn_end", toolTurn, ctx);
		expect(compact).not.toHaveBeenCalled();
	});

	it("keeps compacting mid-run with resume at the hard threshold", () => {
		const { turnEnd } = bothRegistered(runtimeWith());
		const { ctx, compact } = fakeCtx({ progress: HARD });
		turnEnd.emit("turn_end", toolTurn, ctx);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not double-compact when the hard trigger is already running", async () => {
		const runtime = runtimeWith();
		const { turnEnd, cache } = bothRegistered(runtime);
		const first = fakeCtx({ progress: HARD, compactImpl: "manual" });
		turnEnd.emit("turn_end", toolTurn, first.ctx);
		expect(runtime.compactInFlight).toBe(true);
		const second = fakeCtx({ progress: HARD, ageMs: 60 * MIN });
		await cache.emit("before_agent_start", beforeStart(), second.ctx);
		expect(second.compact).not.toHaveBeenCalled();
	});

	it("blocks the hard trigger while the pre-request compaction runs", async () => {
		const runtime = runtimeWith();
		const { turnEnd, cache } = bothRegistered(runtime);
		const pre = fakeCtx({ progress: SOFT + 100, ageMs: 60 * MIN, compactImpl: "manual" });
		const pending = cache.emit("before_agent_start", beforeStart(), pre.ctx);
		const mid = fakeCtx({ progress: HARD });
		turnEnd.emit("turn_end", toolTurn, mid.ctx);
		expect(mid.compact).not.toHaveBeenCalled();
		pre.pending.complete!();
		await pending;
	});
});

describe("startCompaction reason override", () => {
	it("uses the supplied reason in the notification", () => {
		const runtime = runtimeWith();
		const { ctx, notify } = fakeCtx();
		startCompaction({ sendMessage: vi.fn() } as never, runtime, ctx as never, { progress: 1, threshold: 2, shouldResume: false, reason: "custom reason" });
		expect(String(notify.mock.calls[0][0])).toBe("Observational memory: compaction custom reason");
	});
});
