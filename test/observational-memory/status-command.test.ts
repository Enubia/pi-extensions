import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerStatusCommand } from "../../extensions/observational-memory/src/commands/status.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import { OM_REFLECTIONS_RECORDED, type Entry } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { invalidateSnapshotConfig, memorySnapshot, snapshotConfig } from "../../extensions/observational-memory/src/status/snapshot.js";
import { assistantEntry, compactionEntry, observation, observationsRecordedEntry, text, userEntry } from "./fixtures.js";

async function status(entries: Entry[], liveTokens: number | null | undefined, overrides: Partial<Runtime["config"]> = {}, windows: { effective?: number; selected?: number; cwd?: string } = {}) {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...snapshotConfig(windows.cwd ?? "/nonexistent"), ...overrides };
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
	registerStatusCommand({ registerCommand } as unknown as ExtensionAPI, runtime);
	const notify = vi.fn();
	const ctx = {
		cwd: windows.cwd ?? "/nonexistent",
		model: { contextWindow: windows.selected ?? 200_000 },
		getContextUsage: liveTokens === undefined ? undefined : () => ({ tokens: liveTokens, contextWindow: windows.effective }),
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
		ui: { notify },
	};
	await registerCommand.mock.calls[0][1].handler("", ctx as unknown as ExtensionCommandContext);
	const output = String(notify.mock.calls[0][0]);
	const progress = output.split("\n").filter((line) => line.startsWith("Next "));
	const currents = progress.map((line) => Number(line.match(/~([\d,]+)/)![1].replaceAll(",", "")));
	return { output, progress, currents, snapshot: memorySnapshot(ctx) };
}

describe("om:status progress", () => {
	it.each([
		{ effective: 128_000, selected: 1_000_000, total: 64_000, percent: 50 },
		{ effective: 1_000_000, selected: 128_000, total: 500_000, percent: 6 },
		{ effective: 200_000, selected: 200_000, total: 100_000, percent: 32 },
		...[undefined, 0, -1, NaN, Infinity, -Infinity].map(effective => ({ effective, selected: 200_000, total: 100_000, percent: 32 })),
		{ effective: NaN, selected: 0, total: 80_000, percent: 40 },
	])("command and snapshot use the same effective ratio threshold: $effective/$selected", async ({ effective, selected, total, percent }) => {
		const cwd = mkdtempSync(join(tmpdir(), "om-virtual-status-"));
		try {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": {
				compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 80_000,
			} }));
			const result = await status([userEntry(text(100))], 32_000, {}, { effective, selected, cwd });
			expect(result.progress[2]).toBe(`Next compaction:  ~32,000 / ${total.toLocaleString()} tokens (${percent}%)`);
			expect(result.snapshot.bars[2]).toEqual({ label: "cmp", current: 32_000, total });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			invalidateSnapshotConfig();
			expect(existsSync(cwd)).toBe(false);
		}
	});

	it("matches the footer's live token progress instead of raw text estimates", async () => {
		const result = await status([userEntry(text(100))], 4_000);
		expect(result.progress).toHaveLength(3);
		for (const line of result.progress) expect(line).toMatch(/~4,000 \/ /);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual([4_000, 4_000, 4_000]);
		expect(result.output).not.toContain("estimated source tokens");
	});

	it.each([undefined, null, NaN, Infinity, -Infinity])("falls back to raw estimates when live usage is %s", async (liveTokens) => {
		const result = await status([userEntry(text(100))], liveTokens);
		expect(result.currents).toEqual([100, 100, 100]);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual(result.currents);
	});

	it("uses each stage's coverage baseline", async () => {
		const reflected = assistantEntry(text(50), { usageTokens: 1_000 });
		const observed = assistantEntry(text(50), { usageTokens: 3_000 });
		const entries: Entry[] = [
			reflected,
			{ type: "custom", id: "reflection", customType: OM_REFLECTIONS_RECORDED, data: {
				reflections: [{ ...observation(2, [reflected.id]), sourceObservationIds: [] }], coversUpToId: reflected.id,
			} },
			observed,
			observationsRecordedEntry([observation(1, [observed.id])], observed.id),
			userEntry(text(100)),
		];
		const result = await status(entries, 4_000);
		expect(result.currents).toEqual([1_000, 3_000, 4_000]);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual(result.currents);
	});

	it("measures growth from the post-compaction baseline", async () => {
		const kept = userEntry(text(100));
		const entries = [compactionEntry(kept.id), kept, assistantEntry(text(50), { usageTokens: 3_000 }), userEntry(text(100))];
		const result = await status(entries, 4_000);
		expect(result.currents).toEqual([1_000, 1_000, 1_000]);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual(result.currents);
	});

	it.each([undefined, 5_000])("falls back when coverage usage is missing or exceeds live usage (%s)", async (usageTokens) => {
		const covered = assistantEntry(text(50), { usageTokens });
		const entries = [covered, observationsRecordedEntry([observation(1, [covered.id])], covered.id), userEntry(text(100))];
		const result = await status(entries, 4_000);
		expect(result.currents).toEqual([100, 4_000, 4_000]);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual(result.currents);
	});

	it.each([undefined, 5_000])("falls back when post-compaction usage is unreliable (%s)", async (usageTokens) => {
		const kept = userEntry(text(100));
		const entries = [compactionEntry(kept.id), kept, assistantEntry(text(50), { usageTokens }), userEntry(text(100))];
		const result = await status(entries, 4_000);
		expect(result.currents).toEqual([250, 250, 250]);
		expect(result.snapshot.bars.map((bar) => bar.current)).toEqual(result.currents);
	});

	it("keeps thresholds from runtime configuration", async () => {
		const result = await status([userEntry(text(100))], 4_000, {
			observeAfterTokens: 8_000,
			reflectAfterTokens: 16_000,
			compactAfterTokensMode: "calibrated",
			compactAfterTokens: 100_000,
		});
		expect(result.progress).toEqual([
			"Next observation: ~4,000 / 8,000 tokens (50%)",
			"Next reflection:  ~4,000 / 16,000 tokens (25%)",
			"Next compaction:  ~4,000 / 100,000 tokens (4%)",
		]);
	});

	it("resolves ratio compaction thresholds against the active model", async () => {
		const result = await status([userEntry(text(100))], 4_000, {
			compactAfterTokensMode: "ratio",
			compactAfterTokensRatio: 0.5,
		});
		expect(result.progress[2]).toBe("Next compaction:  ~4,000 / 100,000 tokens (4%)");
	});
});
