import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveCompactionPolicy, type CompactionPolicy } from "../config.js";
import { updateSettingsFile } from "../settings.js";
import { describeThreshold, parseFactor, patchSettings, presetOptions, ratioFromOption } from "./factor-core.js";

function describePolicy(policy: CompactionPolicy): string {
	const value = policy.mode === "ratio"
		? describeThreshold(policy.ratio, policy.contextWindow)
		: `calibrated mode (~${policy.threshold.toLocaleString()} tokens)`;
	return `${value} [${policy.source}]`;
}

export function registerFactorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("om:factor", {
		description: "Set the selected provider's global OM compaction factor: /om:factor [ratio | percent | reset]",
		handler: async (args, ctx) => {
			const model = ctx.model;
			const provider = model?.provider;
			if (!provider) {
				ctx.ui.notify("/om:factor: select a model first; no current provider", "error");
				return;
			}
			const usage = ctx.getContextUsage?.();
			const current = resolveCompactionPolicy(loadConfig(ctx.cwd), model, usage?.contextWindow);
			const argument = args.trim();
			const reset = argument === "reset";
			let ratio: number | undefined;
			if (argument && !reset) {
				const parsed = parseFactor(argument);
				if (!parsed.ok) {
					ctx.ui.notify(`/om:factor: ${parsed.error}`, "error");
					return;
				}
				ratio = parsed.ratio;
			} else if (!reset) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`/om:factor [ratio | percent | reset] — global provider ${provider}; current: ${describePolicy(current)}`, "info");
					return;
				}
				const choice = await ctx.ui.select(
					`Global factor for ${provider} — current: ${describePolicy(current)}`,
					presetOptions(current.contextWindow, current.mode === "ratio" ? current.ratio : undefined),
				);
				if (choice === undefined) return;
				ratio = ratioFromOption(choice);
				if (ratio === undefined) {
					ctx.ui.notify("/om:factor: could not parse selection", "error");
					return;
				}
			}
			const path = join(getAgentDir(), "settings.json");
			try {
				updateSettingsFile(path, raw => patchSettings(raw, provider, ratio));
			} catch (error) {
				ctx.ui.notify(`/om:factor: failed to write ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const effective = resolveCompactionPolicy(loadConfig(ctx.cwd), model, usage?.contextWindow);
			const masked = effective.source === "project-provider" || effective.source === "project-default";
			ctx.ui.notify(`Observational memory: global factor for ${provider} ${reset ? "reset" : `saved (${ratio})`}; effective: ${describePolicy(effective)}${masked ? "; project settings override the global factor" : ""}`, masked ? "warning" : "info");
			await ctx.reload();
		},
	});
}
