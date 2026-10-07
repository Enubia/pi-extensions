import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerStatusCommand } from "../../extensions/observational-memory/src/commands/status.js";
import { registerViewCommand } from "../../extensions/observational-memory/src/commands/view.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import type { Entry } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { observation, observationsRecordedEntry, reflection, reflectionsRecordedEntry, userEntry } from "./fixtures.js";

function ledger() {
	const user = userEntry("hello");
	const observations = [observation(1, [user.id]), observation(2, [user.id])];
	const first = reflection(10, [observations[0].id], undefined, "First durable fact.");
	const second = reflection(11, [observations[1].id], undefined, "Second durable fact.");
	const merged = reflection(12, [observations[0].id, observations[1].id], [first.id, second.id], "Merged durable fact.");
	const entries: Entry[] = [
		user,
		observationsRecordedEntry(observations, user.id),
		reflectionsRecordedEntry([first, second], user.id),
		reflectionsRecordedEntry([merged], user.id),
	];
	return { entries, first, second, merged };
}

async function runCommand(name: "status" | "view", entries: Entry[], args = "", config: Partial<Runtime["config"]> = {}) {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...runtime.config, ...config };
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
	const pi = { registerCommand } as unknown as ExtensionAPI;
	if (name === "status") registerStatusCommand(pi, runtime);
	else registerViewCommand(pi, runtime, { copyToClipboard: async () => true });
	const notify = vi.fn();
	const ctx = {
		cwd: "/nonexistent",
		model: { contextWindow: 200_000 },
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
		ui: { notify },
	};
	await registerCommand.mock.calls[0][1].handler(args, ctx as unknown as ExtensionCommandContext);
	return String(notify.mock.calls[0][0]);
}

describe("om:status reflection pool", () => {
	it("reports recorded, superseded, active reflections and the active pool against max and target", async () => {
		const { entries, merged } = ledger();
		const activeTokens = Math.ceil(`[${merged.id}] ${merged.content}`.length / 4);
		const output = await runCommand("status", entries, "", { reflectionsPoolMaxTokens: 8_000, reflectionsPoolTargetTokens: 4_000 });
		expect(output).toContain("Reflections:  3 recorded / 2 superseded / 1 active / 0 visible");
		expect(output).toContain(`Active reflection pool:  ~${activeTokens} / 8,000 max tokens (0%), target 4,000`);
	});

	it("shows the merger error among last errors", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.lastMergerError = "merger boom";
		const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
		registerStatusCommand({ registerCommand } as unknown as ExtensionAPI, runtime);
		const notify = vi.fn();
		await registerCommand.mock.calls[0][1].handler("", { cwd: "/nonexistent", sessionManager: { getBranch: () => [], getEntries: () => [] }, ui: { notify } } as unknown as ExtensionCommandContext);
		expect(String(notify.mock.calls[0][0])).toContain("Merger: merger boom");
	});
});

describe("om:view full", () => {
	it("hides superseded reflections and shows how many are hidden", async () => {
		const { entries, first, second, merged } = ledger();
		const output = await runCommand("view", entries, "full");
		expect(output).toContain(`[${merged.id}] ${merged.content}`);
		expect(output).not.toContain(first.content);
		expect(output).not.toContain(second.content);
		expect(output).toContain("2 superseded reflections hidden");
	});

	it("shows no hidden-count line when nothing is superseded", async () => {
		const { entries } = ledger();
		const output = await runCommand("view", entries.slice(0, 3), "full");
		expect(output).not.toContain("superseded");
	});
});
