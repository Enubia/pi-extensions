import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFactorCommand } from "../../extensions/observational-memory/src/commands/factor.js";
import { updateSettingsFile } from "../../extensions/observational-memory/src/settings.js";
import { patchModelSettings } from "../../extensions/observational-memory/src/commands/model.js";

let root: string;
let cwd: string;
let path: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "om-factor-command-"));
	cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	path = join(root, "settings.json");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function command() {
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
	registerFactorCommand({ registerCommand } as unknown as ExtensionAPI);
	const ctx = {
		cwd, hasUI: true,
		model: { provider: "openai", contextWindow: 272_000 },
		getContextUsage: () => ({ tokens: 32_000, contextWindow: 200_000 }),
		ui: { notify: vi.fn(), select: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>() },
		reload: vi.fn().mockResolvedValue(undefined),
	};
	return { ctx, run: (args: string) => registerCommand.mock.calls[0][1].handler(args, ctx as unknown as ExtensionCommandContext) };
}

describe("provider factor command", () => {
	it("saves the current provider globally, leaving legacy defaults and other providers intact", async () => {
		writeFileSync(path, JSON.stringify({ theme: "dark", "observational-memory": { compactAfterTokensMode: "calibrated", compactAfterTokensRatioByProvider: { anthropic: 0.15 } } }));
		const { ctx, run } = command();
		await run("50%");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", "observational-memory": { compactAfterTokensMode: "calibrated", compactAfterTokensRatioByProvider: { anthropic: 0.15, openai: 0.5 } } });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("global factor for openai saved (0.5)"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("100,000"), "info");
		expect(ctx.reload).toHaveBeenCalledTimes(1);
		expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
	});

	it("resets only the selected global override", async () => {
		writeFileSync(path, JSON.stringify({ "observational-memory": { compactAfterTokensRatioByProvider: { openai: 0.5, anthropic: 0.15 } } }));
		const { ctx, run } = command();
		await run("reset");
		expect(JSON.parse(readFileSync(path, "utf8"))["observational-memory"].compactAfterTokensRatioByProvider).toEqual({ anthropic: 0.15 });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("calibrated mode (~81,000 tokens)"), "info");
		expect(ctx.reload).toHaveBeenCalledTimes(1);
	});

	it("previews effective project policy and window, warns that project settings mask the save", async () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { compactAfterTokensRatioByProvider: { openai: 0.15 } } }));
		const { ctx, run } = command();
		ctx.ui.select.mockImplementation(async (_title, options) => options.find(option => option.startsWith("0.5 ")));
		await run("");
		expect(ctx.ui.select.mock.calls[0][0]).toContain("Global factor for openai");
		expect(ctx.ui.select.mock.calls[0][0]).toContain("30,000");
		expect(ctx.ui.select.mock.calls[0][1]).toContain("0.15 · 15% — ~30,000 tokens (current)");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("project settings override the global factor"), "warning");
		expect(JSON.parse(readFileSync(path, "utf8"))["observational-memory"].compactAfterTokensRatioByProvider.openai).toBe(0.5);
	});

	it("does not write or reload after picker cancellation", async () => {
		const { ctx, run } = command();
		ctx.ui.select.mockResolvedValue(undefined);
		await run("");
		expect(existsSync(path)).toBe(false);
		expect(ctx.reload).not.toHaveBeenCalled();
	});

	it("rejects invalid picker output", async () => {
		const { ctx, run } = command();
		ctx.ui.select.mockResolvedValue("invalid");
		await run("");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not parse selection"), "error");
		expect(existsSync(path)).toBe(false);
	});

	it("provides headless usage without opening a picker or writing", async () => {
		const { ctx, run } = command();
		ctx.hasUI = false;
		await run("");
		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("global provider openai"), "info");
		expect(existsSync(path)).toBe(false);
	});

	it("requires a selected provider", async () => {
		const { ctx, run } = command();
		Reflect.deleteProperty(ctx, "model");
		await run("0.5");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no current provider"), "error");
		expect(ctx.reload).not.toHaveBeenCalled();
		expect(existsSync(path)).toBe(false);
	});

	it("rejects invalid input before writing", async () => {
		const { ctx, run } = command();
		await run("100%");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("factor must be between"), "error");
		expect(ctx.reload).not.toHaveBeenCalled();
		expect(existsSync(path)).toBe(false);
	});

	it("preserves malformed settings and releases the lock after failure", async () => {
		writeFileSync(path, "broken");
		const { ctx, run } = command();
		await run("0.5");
		expect(readFileSync(path, "utf8")).toBe("broken");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failed to write"), "error");
		expect(ctx.reload).not.toHaveBeenCalled();
		expect(readdirSync(root).sort()).toEqual(["project", "settings.json"]);
	});

	it("fails safely when another process owns the host-compatible settings lock", async () => {
		writeFileSync(path, "{}");
		const release = lockfile.lockSync(path, { realpath: false });
		try {
			const { ctx, run } = command();
			await run("0.5");
			expect(readFileSync(path, "utf8")).toBe("{}");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failed to write"), "error");
			expect(ctx.reload).not.toHaveBeenCalled();
		} finally {
			release();
		}
	});

	it("preserves a later worker-model update and a second provider update", async () => {
		await command().run("0.5");
		updateSettingsFile(path, raw => patchModelSettings(raw, { provider: "worker", id: "small" }));
		const { ctx, run } = command();
		ctx.model.provider = "anthropic";
		await run("0.15");
		expect(JSON.parse(readFileSync(path, "utf8"))["observational-memory"]).toEqual({ model: { provider: "worker", id: "small" }, compactAfterTokensRatioByProvider: { openai: 0.5, anthropic: 0.15 } });
		expect(readdirSync(root).sort()).toEqual(["project", "settings.json"]);
	});
});
