import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactionPolicy, type CacheAwareIdle } from "../config.js";
import type { CacheColdReason, Runtime } from "../runtime.js";
import type { Entry } from "../session-ledger/index.js";
import { compactionProgress, startCompaction, type TriggerCtx } from "./compaction-trigger.js";

type ModelLike = {
	provider?: string;
	id?: string;
	contextWindow?: number;
	promptCache?: { short?: number };
};

type CacheCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: TriggerCtx["ui"];
	model?: ModelLike;
	getContextUsage?: TriggerCtx["getContextUsage"];
	sessionManager?: TriggerCtx["sessionManager"];
	compact: TriggerCtx["compact"];
};

export function cachePolicyTtlMs(model: { promptCache?: { short?: number } } | undefined): number | undefined {
	const seconds = model?.promptCache?.short;
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function lastAssistantTimestamp(entries: Entry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; timestamp?: unknown } | undefined;
		if (message?.role === "assistant" && typeof message.timestamp === "number") return message.timestamp;
	}
	return undefined;
}

export function idleWindowMs(idle: CacheAwareIdle, ttlMs: number | undefined): number | undefined {
	if (idle === false) return undefined;
	return idle === "auto" ? ttlMs : idle * 1000;
}

export function softThreshold(hard: number, softFraction: number): number {
	return Math.floor(hard * softFraction);
}

function isIdleCold(runtime: Runtime, entries: Entry[], model: ModelLike | undefined, now: number): boolean {
	const window = idleWindowMs(runtime.config.cacheAwareCompaction.idle, cachePolicyTtlMs(model));
	if (window === undefined) return false;
	const touches = [lastAssistantTimestamp(entries), runtime.cacheLastWarmAt].filter((value): value is number => value !== undefined);
	if (touches.length === 0) return false;
	return now - Math.max(...touches) > window;
}

function gate(runtime: Runtime, ctx: { cwd: string; hasUI: boolean }): boolean {
	runtime.ensureConfig(ctx.cwd);
	return runtime.config.cacheAwareCompaction.enabled && runtime.active && ctx.hasUI;
}

function measure(runtime: Runtime, ctx: CacheCtx): { progress: number; hard: number; soft: number } | undefined {
	const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
	if (!entries) return undefined;
	const usage = ctx.getContextUsage?.();
	const progress = compactionProgress(entries, usage?.tokens);
	const hard = resolveCompactionPolicy(runtime.config, ctx.model, usage?.contextWindow).threshold;
	return { progress, hard, soft: softThreshold(hard, runtime.config.cacheAwareCompaction.softFraction) };
}

function awaitableCtx(ctx: CacheCtx, settle: () => void): TriggerCtx {
	return {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
		compact: (options) => ctx.compact({
			onComplete: () => {
				options.onComplete?.();
				settle();
			},
			onError: (error) => {
				options.onError?.(error);
				settle();
			},
		}),
	};
}

export function registerCacheAwareCompaction(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("model_select", (event, ctx) => {
		if (!gate(runtime, ctx)) return;
		if (!runtime.config.cacheAwareCompaction.onModelChange) return;
		const previous = event.previousModel;
		if (!previous) return;
		if (previous.provider === event.model.provider && previous.id === event.model.id) return;
		runtime.cacheColdReason = "model-change";
	});

	pi.on("cache_warming_decision", (_event, ctx) => {
		if (!gate(runtime, ctx)) return;
		runtime.cacheLastWarmAt = Date.now();
		if (runtime.config.cacheAwareCompaction.idle === false) return;
		const measured = measure(runtime, ctx as unknown as CacheCtx);
		if (measured && measured.progress >= measured.soft) return { action: "stop" as const };
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!gate(runtime, ctx)) return;
		if (runtime.compactInFlight || runtime.autoCompactSuspended || runtime.consolidationInFlight) return;
		const pending = runtime.cacheColdReason;
		const cacheCtx = ctx as unknown as CacheCtx;
		const measured = measure(runtime, cacheCtx);
		if (!measured) return;
		if (measured.progress < measured.soft) {
			runtime.cacheColdReason = undefined;
			return;
		}
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const now = Date.now();
		const reason: CacheColdReason | undefined = pending ?? (isIdleCold(runtime, entries, cacheCtx.model, now) ? "idle" : undefined);
		if (!reason) return;
		runtime.lastColdSignal = { reason, at: now };
		const description = `prompt cache cold (${reason}) at ~${measured.progress.toLocaleString()} tokens (soft ${measured.soft.toLocaleString()}, hard ${measured.hard.toLocaleString()})`;
		await new Promise<void>((resolve) => {
			const started = startCompaction(pi, runtime, awaitableCtx(cacheCtx, resolve), {
				progress: measured.progress,
				threshold: measured.hard,
				shouldResume: false,
				reason: description,
			});
			if (started) runtime.cacheColdReason = undefined;
			else resolve();
		});
	});
}
