import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import { THINKING_LEVEL_VALUES, type ConfiguredModel } from "../config.js";
import type { Runtime } from "../runtime.js";
import { updateSettingsFile } from "../settings.js";

const SETTINGS_KEY = "observational-memory";
const THINKING_LEVELS = THINKING_LEVEL_VALUES;
const SESSION_MODEL = "(session model — unset)";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isThinkingLevel(value: string): value is ModelThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseModelArgument(input: string): { ok: true; model: ConfiguredModel | undefined } | { ok: false; error: string } {
	const raw = input.trim();
	if (raw === "clear" || raw === "unset" || raw === "none") return { ok: true, model: undefined };
	const [ref, thinking] = raw.split(":", 2);
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return { ok: false, error: `"${raw}" is not provider/model[:thinking]` };
	const model: ConfiguredModel = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
	if (thinking !== undefined) {
		if (!isThinkingLevel(thinking)) return { ok: false, error: `unknown thinking level "${thinking}" (${THINKING_LEVELS.join(", ")})` };
		model.thinking = thinking;
	}
	return { ok: true, model };
}

export function patchModelSettings(rawFile: string, model: ConfiguredModel | undefined): string {
	const parsed = rawFile.trim().length === 0 ? {} : (JSON.parse(rawFile.replace(/^\uFEFF/, "")) as unknown);
	const settings = record(parsed);
	if (!settings) throw new Error("settings.json does not contain a JSON object");
	const nested = { ...(record(settings[SETTINGS_KEY]) ?? {}) };
	if (model) nested.model = model;
	else delete nested.model;
	return `${JSON.stringify({ ...settings, [SETTINGS_KEY]: nested }, null, 2)}\n`;
}

export function describeModel(model: ConfiguredModel | undefined): string {
	if (!model) return "session model";
	return `${model.provider}/${model.id}${model.thinking ? `:${model.thinking}` : ""}`;
}

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

type RegistryModel = { provider: string; id: string; reasoning?: boolean };

export function registerModelCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:model", {
		description: "Pick the observational-memory worker model: /om:model [provider/model[:thinking] | clear]",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const current = runtime.config.model;
			const argument = (args ?? "").trim();
			let model: ConfiguredModel | undefined;

			if (argument.length > 0) {
				const parsed = parseModelArgument(argument);
				if (!parsed.ok) {
					ctx.ui.notify(`/om:model: ${parsed.error}`, "error");
					return;
				}
				model = parsed.model;
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify(`/om:model: usage: /om:model provider/model[:thinking] — current: ${describeModel(current)}`, "info");
					return;
				}
				const available = (ctx.modelRegistry.getAvailable() as RegistryModel[])
					.map((m) => `${m.provider}/${m.id}`)
					.sort();
				const currentRef = current ? `${current.provider}/${current.id}` : SESSION_MODEL;
				const options = [SESSION_MODEL, ...available.filter((ref) => ref !== currentRef)];
				if (currentRef !== SESSION_MODEL) options.unshift(currentRef);
				const choice = await ctx.ui.select(`Memory worker model — current: ${describeModel(current)}`, options);
				if (choice === undefined) return;
				if (choice === SESSION_MODEL) {
					model = undefined;
				} else {
					const slash = choice.indexOf("/");
					const picked: ConfiguredModel = { provider: choice.slice(0, slash), id: choice.slice(slash + 1) };
					const registryModel = (ctx.modelRegistry.getAvailable() as RegistryModel[]).find((m) => m.provider === picked.provider && m.id === picked.id);
					if (registryModel?.reasoning !== false) {
						const thinking = await ctx.ui.select(
							`Thinking level for ${choice}`,
							[...THINKING_LEVELS],
						);
						if (thinking === undefined) return;
						if (isThinkingLevel(thinking)) picked.thinking = thinking;
					}
					model = picked;
				}
			}

			const path = settingsPath();
			try {
				updateSettingsFile(path, raw => patchModelSettings(raw, model));
			} catch (error) {
				ctx.ui.notify(`/om:model: failed to write ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			ctx.ui.notify(`Observational memory: worker model → ${describeModel(model)}`, "info");
			await ctx.reload();
		},
	});
}
