import { loadConfig, resolveCompactionPolicy, type Config } from "../config.js";
import { compactionProgress } from "../hooks/compaction-trigger.js";
import { readEnabledFromLedger, sumCostEntries, type CostTotal } from "../runtime.js";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	realTokensSinceAnchor,
	type Entry,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

export { OM_PAUSE_STATUS_KEY, parsePauseStatus } from "./pause-status.js";

export type MemoryBar = { label: string; current: number; total: number };

export type MemorySnapshot = {
	enabled: boolean;
	bars: MemoryBar[];
	cost: CostTotal;
};

export type SnapshotCtx = {
	cwd?: string;
	model?: { provider?: string; contextWindow?: number };
	getContextUsage?: () => { tokens: number | null; contextWindow?: number } | undefined;
	sessionManager?: { getBranch?: () => unknown; getEntries?: () => unknown };
};

const configs = new Map<string, Config>();

export function snapshotConfig(cwd: string): Config {
	let config = configs.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configs.set(cwd, config);
	}
	return config;
}

export function invalidateSnapshotConfig(): void {
	configs.clear();
}

export function stageProgress(entries: Entry[], customType: V3MemoryCustomType, raw: (entries: Entry[]) => number, live: number | null | undefined): number {
	if (typeof live === "number" && Number.isFinite(live)) {
		const real = realTokensSinceAnchor(entries, customType, live);
		if (real !== undefined) return real;
	}
	return raw(entries);
}

export function memorySnapshot(ctx: SnapshotCtx): MemorySnapshot {
	const cwd = ctx.cwd ?? process.cwd();
	const config = snapshotConfig(cwd);
	const branch = (ctx.sessionManager?.getBranch?.() ?? []) as Entry[];
	const all = (ctx.sessionManager?.getEntries?.() ?? branch) as Entry[];
	const usage = ctx.getContextUsage?.();
	const live = usage?.tokens;

	return {
		enabled: readEnabledFromLedger(branch),
		bars: [
			{ label: "obs", current: stageProgress(branch, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, live), total: config.observeAfterTokens },
			{ label: "ref", current: stageProgress(branch, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, live), total: config.reflectAfterTokens },
			{ label: "cmp", current: compactionProgress(branch, live), total: resolveCompactionPolicy(config, ctx.model, usage?.contextWindow).threshold },
		],
		cost: sumCostEntries(all),
	};
}
