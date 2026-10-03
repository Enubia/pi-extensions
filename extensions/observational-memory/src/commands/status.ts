import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { resolveCompactAfterTokens } from "../config.js";
import { compactionProgress as getCompactionProgress } from "../hooks/compaction-trigger.js";
import type { Runtime } from "../runtime.js";
import { stageProgress } from "../status/snapshot.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
				[addedSuffix(drift.reflectionsOnlyInFull.length)],
			);
			const usage = ctx.getContextUsage?.();
			const liveTokens = usage?.tokens;
			const obsProgress = stageProgress(entries, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, liveTokens);
			const reflectionProgress = stageProgress(entries, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, liveTokens);
			const compactionProgress = getCompactionProgress(entries, liveTokens);
			const compactThreshold = resolveCompactAfterTokens(runtime.config, usage?.contextWindow, ctx.model?.contextWindow);

			const modeLines: string[] = [];
			if (!runtime.enabled) modeLines.push("Off for this session (/om on to enable)");
			if (runtime.config.passive === true) {
				modeLines.push("Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active");
			}
			const passiveLines = modeLines.length > 0 ? ["── Mode ──", ...modeLines, ""] : [];

			const lines = [
				...passiveLines,
				"── Memory ──",
				observationLine,
				reflectionLine,
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
				"",
				"── Session ──",
				`Worker cost: $${runtime.cost.usd.toFixed(4)} (${runtime.cost.runs} run${runtime.cost.runs === 1 ? "" : "s"})`,
				`Compaction: on turn_end, resume mid-run ${runtime.config.resumeAfterMidRunCompaction ? "on" : "off"}, tail ~${runtime.config.tailTokens.toLocaleString()} tokens${runtime.lastCompactionWait ? `, last fold ${runtime.lastCompactionWait} for workers` : ""}`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError || runtime.lastResumeError || runtime.autoCompactSuspended) {
				lines.push("", "── Last error ──");
				if (runtime.autoCompactSuspended) lines.push(`Auto-compaction suspended: ${runtime.autoCompactSuspended} (run /om:compact to retry)`);
				if (runtime.lastResumeError) lines.push(`Resume: ${runtime.lastResumeError}`);
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
