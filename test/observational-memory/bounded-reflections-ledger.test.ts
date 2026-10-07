import { describe, expect, it } from "vitest";
import { formatRecallResultForTui, recallObservationTool, type RecallObservationToolDetails } from "../../extensions/observational-memory/src/tools/recall-observation.js";
import {
	buildCompactionProjection,
	foldLedger,
	fullProjection,
	isReflection,
	recallMemorySources,
	type Entry,
} from "../../extensions/observational-memory/src/session-ledger/index.js";
import {
	compactionEntry,
	memoryId,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	userEntry,
} from "./fixtures.js";

function ledger() {
	const u1 = userEntry("first");
	const u2 = userEntry("second");
	const obs = [observation(1, [u1.id]), observation(2, [u2.id])];
	const base = reflection(10, [obs[0].id]);
	const other = reflection(11, [obs[1].id]);
	const merged = reflection(12, [obs[0].id, obs[1].id], [base.id, other.id]);
	const observed = observationsRecordedEntry(obs, u2.id);
	const first = reflectionsRecordedEntry([base, other], u2.id);
	const mergeEntry = reflectionsRecordedEntry([merged], u2.id);
	return { u1, u2, obs, base, other, merged, observed, first, mergeEntry };
}

describe("reflection validator", () => {
	it("accepts the optional supersede field and rejects malformed values", () => {
		const { merged, base } = ledger();
		expect(isReflection(merged)).toBe(true);
		expect(isReflection(base)).toBe(true);
		expect(isReflection({ ...merged, supersedesReflectionIds: [] })).toBe(false);
		expect(isReflection({ ...merged, supersedesReflectionIds: "abc" })).toBe(false);
		expect(isReflection({ ...merged, supersedesReflectionIds: [1] })).toBe(false);
	});
});

describe("foldLedger with supersede entries", () => {
	it("yields only non-superseded reflections while keeping every record addressable", () => {
		const l = ledger();
		const folded = foldLedger([l.u1, l.u2, l.observed, l.first, l.mergeEntry]);
		expect(folded.reflections.map((r) => r.id)).toEqual([l.merged.id]);
		expect(Array.from(folded.reflectionsById.keys())).toEqual([l.base.id, l.other.id, l.merged.id]);
		expect(Array.from(folded.supersededReflectionIds)).toEqual([[l.base.id, l.merged.id], [l.other.id, l.merged.id]]);
	});

	it("treats superseding an unknown id as a no-op", () => {
		const l = ledger();
		const ghost = reflection(13, [l.obs[0].id], [memoryId(999)]);
		const folded = foldLedger([l.u1, l.u2, l.observed, l.first, reflectionsRecordedEntry([ghost], l.u2.id)]);
		expect(folded.reflections.map((r) => r.id)).toEqual([l.base.id, l.other.id, ghost.id]);
		expect(folded.supersededReflectionIds.size).toBe(0);
	});

	it("keeps a reflection active when only a later entry past the fold boundary supersedes it", () => {
		const l = ledger();
		const entries = [l.u1, l.u2, l.observed, l.first, l.mergeEntry];
		const folded = foldLedger(entries, { upToEntryId: l.first.id });
		expect(folded.reflections.map((r) => r.id)).toEqual([l.base.id, l.other.id]);
	});
});

describe("compaction projection with supersede entries", () => {
	function branch() {
		const l = ledger();
		const tail = userEntry("tail");
		const fullFoldCompaction: Entry = {
			type: "compaction",
			id: "c-full",
			firstKeptEntryId: tail.id,
			summary: "s",
			details: { type: "om.folded", version: 1, fullFold: true, observations: [], reflections: [] },
		};
		return { l, tail, fullFoldCompaction };
	}

	it("excludes superseded reflections when the superseding entry is inside the reflections boundary", () => {
		const { l, tail, fullFoldCompaction } = branch();
		const entries = [l.u1, l.u2, l.observed, l.first, l.mergeEntry, tail, fullFoldCompaction, userEntry("next")];
		const projection = buildCompactionProjection(entries, tail.id, { observationsPoolMaxTokens: 1 });
		expect(projection.reflections.map((r) => r.id)).toEqual([l.merged.id]);
	});

	it("keeps superseded reflections when the superseding entry is outside the reflections boundary", () => {
		const { l, tail, fullFoldCompaction } = branch();
		const next = userEntry("next");
		const lateMerge = reflectionsRecordedEntry([l.merged], next.id);
		const entries = [l.u1, l.u2, l.observed, l.first, tail, fullFoldCompaction, next, lateMerge];
		const projection = buildCompactionProjection(entries, tail.id, { observationsPoolMaxTokens: Number.POSITIVE_INFINITY });
		expect(projection.reflections.map((r) => r.id)).toEqual([l.base.id, l.other.id]);
		expect(fullProjection(entries, next.id).reflections.map((r) => r.id)).toEqual([l.merged.id]);
	});
});

describe("recall of superseded and merged reflections", () => {
	it("reports the superseding id on a superseded reflection", () => {
		const l = ledger();
		const result = recallMemorySources([l.u1, l.u2, l.observed, l.first, l.mergeEntry], l.base.id);
		expect(result.status).toBe("found");
		expect(result.reflections.map((r) => r.supersededBy)).toEqual([l.merged.id]);
		expect(result.observations.map((o) => o.observation.id)).toEqual([l.obs[0].id]);
	});

	it("reports superseded reflection ids and supporting observations on a merged reflection", () => {
		const l = ledger();
		const result = recallMemorySources([l.u1, l.u2, l.observed, l.first, l.mergeEntry], l.merged.id);
		expect(result.reflections.map((r) => r.reflection.supersedesReflectionIds)).toEqual([[l.base.id, l.other.id]]);
		expect(result.reflections[0].supersededBy).toBeUndefined();
		expect(result.observations.map((o) => o.observation.id)).toEqual([l.obs[0].id, l.obs[1].id]);
	});
});

describe("sessions recorded before supersede entries", () => {
	it("fold identically", () => {
		const u1 = userEntry("first");
		const u2 = userEntry("second");
		const obs = [observation(1, [u1.id]), observation(2, [u2.id])];
		const reflections = [reflection(10, [obs[0].id]), reflection(11, [obs[1].id])];
		const entries = [u1, u2, observationsRecordedEntry(obs, u2.id), reflectionsRecordedEntry(reflections, u2.id), compactionEntry(u2.id)];
		const folded = foldLedger(entries);
		expect(folded.reflections).toEqual(reflections);
		expect(folded.supersededReflectionIds.size).toBe(0);
		expect(fullProjection(entries).reflections).toEqual(reflections);
		expect(JSON.stringify(reflections)).not.toContain("supersedes");
	});
});

describe("recall tool output", () => {
	async function recall(entries: Entry[], id: string) {
		const result = await recallObservationTool.execute("call", { id }, undefined, undefined, { sessionManager: { getBranch: () => entries } } as never);
		return { text: (result.content[0] as { text: string }).text, details: result.details as RecallObservationToolDetails };
	}

	it("states the superseding id for a superseded reflection", async () => {
		const l = ledger();
		const { text, details } = await recall([l.u1, l.u2, l.observed, l.first, l.mergeEntry], l.base.id);
		expect(text).toContain(`[${l.base.id}] [superseded by ${l.merged.id}] ${l.base.content}`);
		expect(details.reflections[0].supersededBy).toBe(l.merged.id);
		expect(formatRecallResultForTui({ content: [], details }, false)).toContain(`${l.base.id} superseded by ${l.merged.id}`);
	});

	it("lists superseded reflection ids and supporting observations for a merged reflection", async () => {
		const l = ledger();
		const { text, details } = await recall([l.u1, l.u2, l.observed, l.first, l.mergeEntry], l.merged.id);
		expect(text).toContain(`[${l.merged.id}] [supersedes ${l.base.id}, ${l.other.id}] ${l.merged.content}`);
		expect(text).toContain(l.obs[0].content);
		expect(text).toContain(l.obs[1].content);
		expect(details.reflections[0].supersedesReflectionIds).toEqual([l.base.id, l.other.id]);
	});
});
