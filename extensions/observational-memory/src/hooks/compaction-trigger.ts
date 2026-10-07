import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RETRYABLE_ERROR_RE } from "../agents/retry.js";
import { resolveCompactionPolicy } from "../config.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	OM_RESUME,
	rawTokensSinceLastCompaction,
	realTokensSinceAnchor,
	type Entry,
} from "../session-ledger/index.js";

export const RESUME_PROMPT =
	"[automatic] Your context was just compacted to free space; no user message was sent. "
	+ "Continue exactly where you left off, as if the compaction had not happened.";

type TurnEndLike = {
	message?: { role?: string; stopReason?: string; errorMessage?: string };
	toolResults?: unknown[];
};

export type TriggerCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model?: { provider?: string; contextWindow?: number };
	getContextUsage?: () => { tokens: number | null; contextWindow?: number } | undefined;
	sessionManager?: { getBranch?: () => unknown; getSessionId?: () => string; getSessionFile?: () => string | undefined };
	compact: (options: {
		onComplete?: () => void;
		onError?: (error: { message: string }) => void;
	}) => void;
};

export function isRetryableErrorTurn(event: TurnEndLike): boolean {
	const message = event.message;
	return message?.role === "assistant"
		&& message.stopReason === "error"
		&& typeof message.errorMessage === "string"
		&& RETRYABLE_ERROR_RE.test(message.errorMessage);
}

export function turnWillContinue(event: TurnEndLike): boolean {
	if (Array.isArray(event.toolResults) && event.toolResults.length > 0) return true;
	const stop = event.message?.stopReason;
	return stop === "toolUse" || stop === "tool_use" || stop === "tool_calls";
}

export function compactionProgress(entries: Entry[], liveTokens: number | null | undefined): number {
	if (typeof liveTokens === "number" && Number.isFinite(liveTokens)) {
		const real = realTokensSinceAnchor(entries, undefined, liveTokens);
		if (real !== undefined) return real;
	}
	return rawTokensSinceLastCompaction(entries);
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (!runtime.active) return;
		if (!ctx.hasUI) return;
		if (runtime.compactInFlight || runtime.autoCompactSuspended) return;
		if (isRetryableErrorTurn(event as TurnEndLike)) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;

		const usage = ctx.getContextUsage?.();
		const progress = compactionProgress(entries, usage?.tokens);
		const threshold = resolveCompactionPolicy(runtime.config, ctx.model, usage?.contextWindow).threshold;
		if (progress < threshold) return;

		const shouldResume = runtime.config.resumeAfterMidRunCompaction && turnWillContinue(event as TurnEndLike);
		startCompaction(pi, runtime, ctx as TriggerCtx, { progress, threshold, shouldResume });
	});
}

export function startCompaction(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	options: { progress?: number; threshold?: number; shouldResume: boolean },
): boolean {
	if (runtime.compactInFlight) return false;
	const hasUI = ctx.hasUI;
	const ui = ctx.ui;
	const { progress, threshold, shouldResume } = options;

	runtime.compactInFlight = true;
	const log = (event: string, data: Record<string, unknown>) => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager?.getSessionId?.(),
		sessionFile: ctx.sessionManager?.getSessionFile?.(),
	}, () => debugLog(event, data));
	log("compaction.trigger", { progress, threshold, shouldResume });
	const resume = () => {
		if (!shouldResume || !runtime.active) return;
		try {
			pi.sendMessage(
				{ customType: OM_RESUME, content: RESUME_PROMPT, display: false },
				{ triggerTurn: true },
			);
			runtime.lastResumeError = undefined;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			runtime.lastResumeError = msg;
			if (hasUI) ui?.notify(`Observational memory: resume failed — ${msg}`, "error");
		}
	};
	if (hasUI) {
		const reason = progress !== undefined && threshold !== undefined
			? `threshold reached (~${progress.toLocaleString()} / ${threshold.toLocaleString()} tokens)`
			: "forced";
		ui?.notify(`Observational memory: compaction ${reason}${shouldResume ? "; will resume the run afterwards" : ""}`, "info");
	}

	try {
		ctx.compact({
			onComplete: () => {
				runtime.compactInFlight = false;
				runtime.autoCompactSuspended = undefined;
				log("compaction.complete", { shouldResume });
				if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
				resume();
			},
			onError: (error) => {
				runtime.compactInFlight = false;
				log("compaction.error", { errorMessage: error.message });
				if (error.message === "Compaction cancelled") return;
				if (shouldResume) runtime.autoCompactSuspended = error.message;
				if (hasUI) {
					ui?.notify(
						`Observational memory: compaction failed — ${error.message}${shouldResume ? ". Auto-compaction suspended for this session until /om:compact succeeds" : ""}`,
						"error",
					);
				}
				resume();
			},
		});
	} catch (error) {
		runtime.compactInFlight = false;
		const msg = error instanceof Error ? error.message : String(error);
		if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
		return false;
	}
	return true;
}
