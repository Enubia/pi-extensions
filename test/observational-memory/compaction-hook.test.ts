import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook, snapCutoff } from "../../extensions/observational-memory/src/hooks/compaction-hook.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import type { Entry } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { assistantEntry, observation, observationsRecordedEntry, text, toolResultEntry, userEntry } from "./fixtures.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi() {
	const handlers = new Map<string, Handler>();
	return {
		pi: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
		fire: (event: unknown, ctx: unknown) => handlers.get("session_before_compact")!(event, ctx),
	};
}

function runtimeWith(overrides: Partial<Runtime["config"]> = {}): Runtime {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...runtime.config, tailTokens: 100, ...overrides };
	return runtime;
}

function branchWithChunks() {
	const u1 = userEntry(text(100));
	const a1 = assistantEntry(text(100));
	const u2 = userEntry(text(100));
	const a2 = assistantEntry(text(100));
	const u3 = userEntry(text(50));
	const a3 = assistantEntry(text(50));
	const chunk1 = observationsRecordedEntry([observation(1, [u1.id, a1.id])], a1.id);
	const chunk2 = observationsRecordedEntry([observation(2, [u2.id, a2.id])], a2.id);
	return { entries: [u1, a1, chunk1, u2, a2, chunk2, u3, a3], u1, a1, u2, a2, u3, a3, chunk1, chunk2 };
}

describe("snapCutoff", () => {
	it("snaps to the chunk boundary whose tail is closest to tailTokens", () => {
		const b = branchWithChunks();
		expect(snapCutoff(b.entries, b.a2.id, 100).firstKeptId).toBe(b.u3.id);
		expect(snapCutoff(b.entries, b.a2.id, 300).firstKeptId).toBe(b.u2.id);
	});

	it("falls back to the proposed cut when no boundary is usable", () => {
		const u1 = userEntry("a");
		const a1 = assistantEntry("b");
		expect(snapCutoff([u1, a1], a1.id, 100)).toEqual({ firstKeptId: a1.id, tail: undefined });
	});

	it("never cuts in front of a tool result", () => {
		const u1 = userEntry(text(100));
		const a1 = assistantEntry(text(10), { stopReason: "toolUse" });
		const t1 = toolResultEntry(text(100));
		const a2 = assistantEntry(text(10));
		const chunk = observationsRecordedEntry([observation(1, [u1.id, a1.id])], a1.id);
		expect(snapCutoff([u1, a1, chunk, t1, a2], t1.id, 50)).toEqual({ firstKeptId: t1.id, tail: undefined });
	});
});

describe("registerCompactionHook", () => {
	function ctxFor(getBranch: () => Entry[]) {
		return { cwd: "/tmp", hasUI: false, ui: { notify: vi.fn() }, sessionManager: { getBranch } };
	}

	it("folds observations into the summary and snaps the cutoff", async () => {
		const { pi, fire } = fakePi();
		const b = branchWithChunks();
		registerCompactionHook(pi as never, runtimeWith());

		const result = await fire(
			{ preparation: { firstKeptEntryId: b.a2.id, tokensBefore: 1_000 }, branchEntries: b.entries },
			ctxFor(() => b.entries),
		) as { compaction: { summary: string; firstKeptEntryId: string } };

		expect(result.compaction.firstKeptEntryId).toBe(b.u3.id);
		expect(result.compaction.summary).toContain("observation 1");
		expect(result.compaction.summary).toContain("observation 2");
	});

	it("waits for an in-flight consolidation and folds what it committed", async () => {
		const { pi, fire } = fakePi();
		const runtime = runtimeWith();
		registerCompactionHook(pi as never, runtime);

		const u1 = userEntry(text(100));
		const a1 = assistantEntry(text(100));
		const u2 = userEntry(text(10));
		let branch: Entry[] = [u1, a1, u2];

		let finish!: () => void;
		runtime.consolidationInFlight = true;
		runtime.consolidationPromise = new Promise<void>((resolve) => {
			finish = () => {
				branch = [u1, a1, observationsRecordedEntry([observation(7, [u1.id, a1.id], "late observation")], a1.id), u2];
				runtime.consolidationInFlight = false;
				runtime.consolidationPromise = null;
				resolve();
			};
		});

		const pending = fire(
			{ preparation: { firstKeptEntryId: u2.id, tokensBefore: 1_000 }, branchEntries: branch },
			ctxFor(() => branch),
		);
		finish();
		const result = await pending as { compaction: { summary: string } };

		expect(runtime.lastCompactionWait).toBe("waited");
		expect(result.compaction.summary).toContain("late observation");
	});

	it("declines ownership when there is nothing to fold", async () => {
		const { pi, fire } = fakePi();
		registerCompactionHook(pi as never, runtimeWith());
		const u1 = userEntry("a");
		const a1 = assistantEntry("b");

		const result = await fire(
			{ preparation: { firstKeptEntryId: a1.id, tokensBefore: 10 }, branchEntries: [u1, a1] },
			ctxFor(() => [u1, a1]),
		);

		expect(result).toBeUndefined();
	});

	it("stays out of the way when the session gate is off", async () => {
		const { pi, fire } = fakePi();
		const runtime = runtimeWith();
		runtime.enabled = false;
		registerCompactionHook(pi as never, runtime);
		const b = branchWithChunks();

		const result = await fire(
			{ preparation: { firstKeptEntryId: b.a2.id, tokensBefore: 10 }, branchEntries: b.entries },
			ctxFor(() => b.entries),
		);

		expect(result).toBeUndefined();
	});

	it("cancels a duplicate compaction while one is running", async () => {
		const { pi, fire } = fakePi();
		const runtime = runtimeWith();
		runtime.compactHookInFlight = true;
		registerCompactionHook(pi as never, runtime);

		const result = await fire({ preparation: { firstKeptEntryId: "x", tokensBefore: 1 }, branchEntries: [] }, ctxFor(() => []));

		expect(result).toEqual({ cancel: true });
	});
});
