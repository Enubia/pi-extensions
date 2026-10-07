import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	entryIndexById,
	isObservationsRecordedEntry,
	isSourceEntry,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";

function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

function isValidCutPoint(entry: Entry): boolean {
	if (entry.type !== "message") return true;
	const role = (entry.message as { role?: string } | undefined)?.role;
	return role === "user" || role === "assistant";
}

function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of chunkBoundaryIndices(branch)) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (!runtime.enabled) return undefined;
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify("Observational memory: another compaction is already in progress; cancelling duplicate", "warning");
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { firstKeptEntryId, tokensBefore } = event.preparation;

			if (runtime.consolidationInFlight) {
				runtime.lastCompactionWait = "waited";
				if (ctx.hasUI) ctx.ui.notify("Observational memory: waiting for in-flight memory workers before folding…", "info");
				await runtime.whenConsolidationIdle();
			} else {
				runtime.lastCompactionWait = "skipped";
			}

			const branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			const snap = snapCutoff(branch, firstKeptEntryId, runtime.config.tailTokens);
			debugLog("compaction.snap", {
				proposed: firstKeptEntryId,
				snapped: snap.firstKeptId,
				tail: snap.tail,
				tailTokens: runtime.config.tailTokens,
				waited: runtime.lastCompactionWait,
			});

			const projection = buildCompactionProjection(branch, snap.firstKeptId, {
				observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
				carryCurrentTask: snap.tail !== undefined,
			});
			const summary = renderSummary(projection.reflections, projection.observations, projection.currentTask);
			if (summary.length === 0) return undefined;

			return {
				compaction: {
					summary,
					firstKeptEntryId: snap.firstKeptId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
