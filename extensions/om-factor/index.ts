import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describeThreshold, parseFactor, patchSettings, presetOptions, ratioFromOption, readRatio } from "./core.ts";

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readSettingsFile(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function writeSettingsFile(path: string, contents: string): void {
	const temp = `${path}.om-factor.tmp`;
	writeFileSync(temp, contents, "utf-8");
	renameSync(temp, path);
}

function currentRatio(path: string): { mode?: string; ratio?: number } {
	try {
		const raw = readSettingsFile(path);
		return raw.trim().length === 0 ? {} : readRatio(JSON.parse(raw.replace(/^\uFEFF/, "")));
	} catch {
		return {};
	}
}

export default function omFactor(pi: ExtensionAPI) {
	pi.registerCommand("om:factor", {
		description: "Set the observational-memory compaction factor (ratio of the context window)",
		handler: async (args, ctx) => {
			const path = settingsPath();
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const existing = currentRatio(path);

			let ratio: number | undefined;
			const argument = (args ?? "").trim();
			if (argument.length > 0) {
				const parsed = parseFactor(argument);
				if (!parsed.ok) {
					ctx.ui.notify(`/om:factor: ${parsed.error}`, "error");
					return;
				}
				ratio = parsed.ratio;
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify(`/om:factor: usage: /om:factor 0.25 — current: ${describeThreshold(existing.ratio ?? 0.68, contextWindow)}`, "info");
					return;
				}
				const choice = await ctx.ui.select(
					`Compaction factor — current: ${existing.mode === "ratio" && existing.ratio !== undefined ? describeThreshold(existing.ratio, contextWindow) : "calibrated mode"}`,
					presetOptions(contextWindow, existing.mode === "ratio" ? existing.ratio : undefined),
				);
				if (choice === undefined) return;
				ratio = ratioFromOption(choice);
				if (ratio === undefined) {
					ctx.ui.notify("/om:factor: could not parse selection", "error");
					return;
				}
			}

			try {
				writeSettingsFile(path, patchSettings(readSettingsFile(path), ratio));
			} catch (error) {
				ctx.ui.notify(`/om:factor: failed to write ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			ctx.ui.notify(`Observational memory: ${describeThreshold(ratio, contextWindow)}`, "info");
			await ctx.reload();
		},
	});
}
