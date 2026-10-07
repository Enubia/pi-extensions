import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runMerger } from "../agents/merger/agent.js";
import { reflectionPoolMetrics } from "../agents/merger/pool.js";
import { ObserverStreamError, runObserver, type ObserverResult } from "../agents/observer/agent.js";
import { selectPriorObservations } from "../agents/observer/prior-context.js";
import { runReflector } from "../agents/reflector/agent.js";
import { withRetries, type RetryOptions } from "../agents/retry.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { formatPauseStatus, OM_PAUSE_STATUS_KEY, type PausedStage } from "../status/pause-status.js";
import {
	OM_COST,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	supersededReflectionIds,
	type CostEntryData,
	type Entry,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: {
		notify: (message: string, type?: "warning" | "info" | "error") => void;
		setStatus?: (key: string, text: string | undefined) => void;
	};
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getEntries?: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type Stage = "observer" | "reflector" | "merger" | "dropper";

class CostCollector {
	stages: Partial<Record<Stage, number>> = {};

	for(stage: Stage): (usd: number) => void {
		return (usd) => {
			if (!Number.isFinite(usd) || usd <= 0) return;
			this.stages[stage] = (this.stages[stage] ?? 0) + usd;
		};
	}

	total(): number {
		return Object.values(this.stages).reduce((sum, usd) => sum + (usd ?? 0), 0);
	}

	entry(): CostEntryData | undefined {
		const usd = this.total();
		return usd > 0 ? { usd, stages: this.stages } : undefined;
	}
}

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

type MergerStageResult = {
	mergedReflections: Reflection[];
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

function activeReflections(folded: ReturnType<typeof foldLedger>, additional: Reflection[]): Reflection[] {
	const all = mergeReflections(Array.from(folded.reflectionsById.values()), additional);
	const superseded = supersededReflectionIds(all);
	return all.filter((reflection) => !superseded.has(reflection.id));
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate, which
	// self-limits after coverage and cannot over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function observationBacklogTokens(entries: Entry[], currentTokens: number | undefined): number {
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens) : undefined;
	return real !== undefined ? real : rawTokensSinceObservationCoverage(entries);
}

function observerBackoffActive(entries: Entry[], runtime: Runtime, identity: string | undefined, tokens: number): boolean {
	const backoff = runtime.observerEmptyBackoff;
	return backoff !== undefined
		&& backoff.sessionIdentity === identity
		&& backoff.coverageId === latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)
		&& tokens < backoff.tokensAtEmpty + runtime.config.observeAfterTokens;
}

function reflectorHasNewObservations(entries: Entry[], runtime: Runtime, identity: string | undefined): boolean {
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return false;
	if (latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) <= latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED)) return false;
	const memo = runtime.reflectorNoProgress;
	return !(memo && memo.sessionIdentity === identity && memo.observationCoverageId === observationCoverageId);
}

export function pausedStages(entries: Entry[], runtime: Runtime, identity: string | undefined, currentTokens: number | undefined): PausedStage[] {
	const stages: PausedStage[] = [];
	if (observerBackoffActive(entries, runtime, identity, observationBacklogTokens(entries, currentTokens))) stages.push("obs");
	if (
		latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)
		&& !reflectorHasNewObservations(entries, runtime, identity)
		&& stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens)
	) stages.push("ref");
	return stages;
}

function pauseStatusText(runtime: Runtime, ctx: ConsolidationCtx): string | undefined {
	if (!runtime.active) return undefined;
	try {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		return formatPauseStatus(pausedStages(entries, runtime, sessionIdentity(ctx), realContextTokens(ctx)));
	} catch {
		return undefined;
	}
}

export function syncPauseStatus(runtime: Runtime, ctx: ConsolidationCtx): void {
	try {
		if (!ctx.hasUI) return;
		const ui = ctx.ui;
		ui?.setStatus?.(OM_PAUSE_STATUS_KEY, pauseStatusText(runtime, ctx));
	} catch {
		return;
	}
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: Stage) => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			// Console Go (opencode.ai) rejects requests without x-opencode-session
			// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
			const model = (cached.model ?? {}) as { provider?: string; baseUrl?: string };
			if (model.provider === "opencode" || model.provider === "opencode-go" || (typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))) {
				const sessionId = ctx.sessionManager.getSessionId?.();
				if (sessionId) {
					return {
						...cached,
						headers: {
							...(cached.headers ?? {}),
							"x-opencode-session": sessionId,
							"x-opencode-client": "pi",
						},
					};
				}
			}
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function sessionIdentity(ctx: ConsolidationCtx): string | undefined {
	const { sessionId, sessionFile } = debugSessionMetadata(ctx);
	return sessionId ?? sessionFile;
}

function retryOptions(stage: Stage, runtime: Runtime, ctx: ConsolidationCtx, force: boolean): RetryOptions {
	const identity = sessionIdentity(ctx);
	return {
		stage,
		maxRetries: runtime.config.agentMaxRetries,
		canContinue: () => (force ? runtime.enabled : runtime.active) && sessionIdentity(ctx) === identity,
	};
}

export function launchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx, options: { force?: boolean } = {}): boolean {
	runtime.ensureConfig(ctx.cwd);
	syncPauseStatus(runtime, ctx);
	if (!options.force && !runtime.active) return false;
	if (runtime.consolidationInFlight) return false;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!options.force && !anyStageDue(entries, runtime, realContextTokens(ctx))) return false;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx, options.force === true);
	}));
	return true;
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	launchConsolidation(pi, runtime, ctx);
}

function recordCost(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx, cost: CostCollector): void {
	const data = cost.entry();
	if (!data) return;
	appendEntry(pi, OM_COST, data);
	const all = ctx.sessionManager.getEntries?.() as Entry[] | undefined;
	if (all) runtime.refreshCost(all);
	else runtime.cost = { usd: runtime.cost.usd + data.usd, runs: runtime.cost.runs + 1 };
	debugLog("consolidation.cost", { ...data, sessionTotalUsd: runtime.cost.usd });
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	force = false,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const cost = new CostCollector();

	try {
		runtime.consolidationPhase = "observer";
		try {
			const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, cost.for("observer"), force);
			if (observerOutcome === "abort") return;
		} catch (error) {
			debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
			return;
		}

		runtime.consolidationPhase = "reflector";
		let reflectorResult: ReflectorStageResult;
		try {
			reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel, cost.for("reflector"), force);
			if (reflectorResult.outcome === "abort") return;
		} catch (error) {
			debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
			return;
		}

		runtime.consolidationPhase = "merger";
		let mergerResult: MergerStageResult = { mergedReflections: [] };
		try {
			mergerResult = await runMergerStage(pi, runtime, ctx, resolveModel, reflectorResult, cost.for("merger"), force);
		} catch (error) {
			debugLog("merger.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "merger", error) });
		}

		runtime.consolidationPhase = "dropper";
		try {
			await runDropperStage(pi, runtime, ctx, resolveModel, [...reflectorResult.sameRunReflections, ...mergerResult.mergedReflections], reflectorResult.effectiveReflectionCoverageId, cost.for("dropper"), force);
		} catch (error) {
			debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
		}
	} finally {
		recordCost(pi, runtime, ctx, cost);
		syncPauseStatus(runtime, ctx);
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	onCost: (usd: number) => void,
	force: boolean,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = observationBacklogTokens(entries, realContextTokens(ctx));
	if (!force && tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = force ? undefined : runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
		redactedSourceEntryIds,
		collapsedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, {
		maxTokens: maxChunkTokens,
		redactSkillReads: runtime.config.observerRedactSkillReads,
		dedupeToolResults: runtime.config.observerDedupeToolResults,
		toolCallEntries: entries,
	});
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const { observations: keptObservations, omitted: priorObservationsOmitted } = selectPriorObservations(
		memory.observations,
		runtime.config.observerPriorObservationsMaxTokens,
	);
	const priorObservations = keptObservations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		redactedEntries: redactedSourceEntryIds.length,
		collapsedEntries: collapsedSourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
		priorObservationsOmitted,
	});

	let observerResult: ObserverResult | undefined;
	try {
		observerResult = await withRetries(() => runObserver({
			model: resolved.model as any,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			env: resolved.env,
			priorReflections,
			priorObservations,
			priorObservationsOmitted,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: runtime.config.model?.thinking ?? "low",
			modelRegistry: ctx.modelRegistry,
			onCost,
		}), retryOptions("observer", runtime, ctx, force));
	} catch (error) {
		if (error instanceof ObserverStreamError) {
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	const observations = observerResult?.observations;
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId, observerResult?.currentTask);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
	onCost: (usd: number) => void,
	force: boolean,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens) : undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (!force && reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };
	const identity = sessionIdentity(ctx);
	if (!force && !reflectorHasNewObservations(entries, runtime, identity)) {
		debugLog("reflector.no_new_observations", { observationCoverageId, reflectionTokens });
		return { outcome: "continue", sameRunReflections: [] };
	}

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const reflections = await withRetries(() => runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
		onCost,
	}), retryOptions("reflector", runtime, ctx, force));
	const data = reflections ? buildReflectionsRecordedData(reflections, observationCoverageId) : undefined;
	if (!reflections || !data) {
		runtime.reflectorNoProgress = { sessionIdentity: identity, observationCoverageId };
		return { outcome: "continue", sameRunReflections: [] };
	}
	runtime.reflectorNoProgress = undefined;
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

async function runMergerStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "merger") => Promise<ResolvedModel | undefined>,
	reflectorResult: ReflectorStageResult,
	onCost: (usd: number) => void,
	force: boolean,
): Promise<MergerStageResult> {
	const none: MergerStageResult = { mergedReflections: [] };
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const reflections = activeReflections(folded, reflectorResult.sameRunReflections);
	const metrics = reflectionPoolMetrics(reflections, runtime.config.reflectionsPoolMaxTokens, runtime.config.reflectionsPoolTargetTokens);
	if (!metrics.ready) return none;

	const coversUpToId = reflectorResult.effectiveReflectionCoverageId ?? latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
	if (!coversUpToId) return none;

	const reflectionIds = reflections.map((reflection) => reflection.id).sort().join(",");
	const identity = sessionIdentity(ctx);
	const memo = runtime.mergerNoProgress;
	if (!force && memo && memo.sessionIdentity === identity && memo.reflectionIds === reflectionIds) {
		debugLog("merger.no_progress_skip", { activeReflectionCount: metrics.activeReflectionCount });
		return none;
	}

	debugLog("merger.stage_start", {
		reflectionTokens: metrics.reflectionTokens,
		maxTokens: metrics.maxTokens,
		targetTokens: metrics.targetTokens,
		activeReflectionCount: metrics.activeReflectionCount,
	});
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: merger running — reflection pool ~${metrics.reflectionTokens.toLocaleString()} / ${metrics.maxTokens.toLocaleString()} max tokens`,
		"info",
	);
	const resolved = await resolveModel("merger");
	if (!resolved) return none;

	const merged = await withRetries(() => runMerger({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		reflections,
		observationIds: Array.from(folded.observationsById.keys()),
		targetTokens: runtime.config.reflectionsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
		onCost,
	}), retryOptions("merger", runtime, ctx, force));
	const data = merged ? buildReflectionsRecordedData(merged, coversUpToId) : undefined;
	if (!merged || !data) {
		runtime.mergerNoProgress = { sessionIdentity: identity, reflectionIds };
		return none;
	}
	runtime.mergerNoProgress = undefined;
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	debugLog("merger.appended", { count: merged.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: merger consolidated ${merged.reduce((sum, item) => sum + (item.supersedesReflectionIds?.length ?? 0), 0)} reflections into ${merged.length}`,
		"info",
	);
	return { mergedReflections: merged };
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
	onCost: (usd: number) => void,
	force: boolean,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const reflectionsForDropper = activeReflections(folded, sameRunReflections);
	const droppedIds = await withRetries(() => runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
		onCost,
	}), retryOptions("dropper", runtime, ctx, force));
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
	const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}
