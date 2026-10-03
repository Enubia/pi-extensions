import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uuidv7, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildPrompt,
	buildTranscript,
	decideNaming,
	FALLBACK_MODELS,
	formatModelRef,
	type ModelRef,
	type NamerConfig,
	parseModelRef,
	patchSettingsModel,
	readConfig,
	sanitizeName,
} from "./core.ts";

const CUSTOM_TYPE = "session-namer";
const DEBUG = !!process.env.PI_SESSION_NAMER_DEBUG;
const debug = (...parts: unknown[]) => {
	if (!DEBUG) return;
	try {
		appendFileSync("/tmp/session-namer-debug.log", `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
	} catch {}
};
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

const loadConfig = (): NamerConfig => {
	try {
		return readConfig(readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return readConfig("{}");
	}
};

const saveModel = (ref: ModelRef | undefined) => {
	let raw = "{}";
	try {
		raw = readFileSync(SETTINGS_PATH, "utf8");
	} catch {}
	writeFileSync(SETTINGS_PATH, patchSettingsModel(raw, ref), "utf8");
};

const resolveModel = (ctx: ExtensionContext, config: NamerConfig) => {
	const registry = ctx.modelRegistry;
	const usable = (provider: string, id: string) => {
		const model = registry.find(provider, id);
		return model && registry.hasConfiguredAuth(model) ? model : undefined;
	};

	const pinned = config.provider && config.model ? usable(config.provider, config.model) : undefined;
	if (pinned) return { model: pinned, pinnedMissing: false };
	const pinnedMissing = !!(config.provider && config.model);

	for (const candidate of FALLBACK_MODELS) {
		const model = usable(candidate.provider, candidate.model);
		if (model) return { model, pinnedMissing };
	}
	return { model: ctx.model, pinnedMissing };
};

const streamOptions = (api: string, thinking: string | undefined) => {
	const options: Record<string, unknown> = { sessionId: uuidv7(), cacheRetention: "none" };
	const level = thinking ?? "off";

	if (api.startsWith("anthropic")) {
		if (level !== "off") {
			options.thinkingEnabled = true;
			options.thinkingEffort = level === "minimal" ? "low" : level;
		}
	} else if (level !== "off") {
		options.reasoningEffort = level;
	} else if (api.includes("codex")) {
		options.reasoningEffort = "none";
	} else {
		options.reasoningEffort = "minimal";
	}

	return options;
};

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let ownedName: string | undefined;
	let manualName = false;
	let settledSinceName = 0;
	let inFlight = false;
	let warnedPinned = false;

	const ownedNameFromSession = (ctx: ExtensionContext): string | undefined => {
		const entries = ctx.sessionManager.getEntries() as { type?: string; customType?: string; data?: { name?: string } }[];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "custom" && entry.customType === CUSTOM_TYPE) return entry.data?.name;
		}
		return undefined;
	};

	const generate = async (ctx: ExtensionContext, currentName: string | undefined): Promise<string | undefined> => {
		const contextEntries = ctx.sessionManager.buildContextEntries();
		const transcript = buildTranscript(contextEntries, config.maxTranscriptChars);
		debug("generate", { entries: contextEntries.length, transcript: transcript.length });
		if (!transcript.trim()) return undefined;

		const { model, pinnedMissing } = resolveModel(ctx, config);
		debug("model", { id: model?.id, provider: model?.provider, pinnedMissing });
		if (pinnedMissing && !warnedPinned && ctx.hasUI) {
			warnedPinned = true;
			const replacement = model ? `${model.provider}/${model.id}` : "none available";
			ctx.ui.notify(`session-namer: ${config.provider}/${config.model} unavailable, using ${replacement}`, "warning");
		}
		if (!model) return undefined;

		const requestContext = {
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildPrompt(transcript, currentName) }],
					timestamp: Date.now(),
				},
			],
		};
		const response = model.api === "pi-virtual"
			? await ctx.modelRegistry.streamSimple(model, requestContext, {
				sessionId: uuidv7(),
				cacheRetention: "none",
				reasoning: config.thinking && config.thinking !== "off" ? config.thinking as ThinkingLevel : undefined,
			}).result()
			: await ctx.modelRegistry.complete(model, requestContext, streamOptions(model.api, config.thinking) as never);

		debug("response", { stopReason: (response as { stopReason?: string }).stopReason, blocks: response.content.length, error: (response as { errorMessage?: string }).errorMessage });

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		return sanitizeName(text, config.maxNameLength);
	};

	const applyName = (ctx: ExtensionContext, name: string, reason: string) => {
		ownedName = name;
		manualName = false;
		settledSinceName = 0;
		pi.setSessionName(name);
		pi.appendEntry(CUSTOM_TYPE, { name });
		if (config.notify && ctx.hasUI) ctx.ui.notify(`session-namer (${reason}): ${name}`, "info");
	};

	const maybeName = async (ctx: ExtensionContext, force = false) => {
		const currentName = pi.getSessionName();
		const decision = force
			? "refresh"
			: decideNaming({
					enabled: config.enabled,
					hasSession: !!ctx.sessionManager.getSessionFile(),
					manualName,
					currentName,
					ownedName,
					settledSinceName,
					refreshEvery: config.refreshEvery,
					inFlight,
				});

		debug("decision", { decision, currentName, ownedName, manualName, settledSinceName, enabled: config.enabled });
		if (decision === "skip") return;

		inFlight = true;
		try {
			const name = await generate(ctx, decision === "refresh" ? currentName : undefined);
			if (name && name !== currentName) applyName(ctx, name, decision);
			else if (name === currentName) settledSinceName = 0;
		} catch (error) {
			debug("error", (error as Error).stack ?? String(error));
			if (config.notify && ctx.hasUI) ctx.ui.notify(`session-namer failed: ${(error as Error).message}`, "warning");
		} finally {
			inFlight = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		warnedPinned = false;
		ownedName = ownedNameFromSession(ctx);
		const currentName = pi.getSessionName();
		manualName = !!currentName && currentName !== ownedName;
		settledSinceName = 0;
		inFlight = false;
	});

	pi.on("session_info_changed", async (event) => {
		if (inFlight) return;
		const name = (event as { name?: string }).name;
		manualName = !!name && name !== ownedName;
		if (manualName) ownedName = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		debug("agent_settled");
		settledSinceName++;
		await maybeName(ctx);
	});

	const currentRef = (): ModelRef | undefined =>
		config.provider && config.model ? { provider: config.provider, id: config.model } : undefined;

	const pinModel = (ctx: ExtensionCommandContext, ref: ModelRef | undefined) => {
		if (ref) {
			const model = ctx.modelRegistry.find(ref.provider, ref.id);
			if (!model) {
				ctx.ui.notify(`session-namer: unknown model ${formatModelRef(ref)}`, "warning");
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify(`session-namer: no authentication configured for ${formatModelRef(ref)}`, "warning");
				return;
			}
		}

		try {
			saveModel(ref);
		} catch (error) {
			ctx.ui.notify(`session-namer: ${(error as Error).message}`, "error");
			return;
		}

		config = loadConfig();
		ctx.ui.notify(ref ? `session-namer model: ${formatModelRef(ref)}` : "session-namer model: auto", "info");
	};

	pi.registerCommand("namer-model", {
		description: "Show or set the model that names sessions (usage: /namer-model [provider/id | auto])",
		handler: async (args, ctx) => {
			config = loadConfig();
			const argument = args.trim();

			if (argument) {
				if (argument === "auto") {
					pinModel(ctx, undefined);
					return;
				}
				const ref = parseModelRef(argument);
				if (!ref) {
					ctx.ui.notify("session-namer: expected provider/id or auto", "warning");
					return;
				}
				pinModel(ctx, ref);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`session-namer model: ${formatModelRef(currentRef())}`, "info");
				return;
			}

			const pinned = currentRef();
			const authenticated = ctx.modelRegistry
				.getAvailable()
				.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
			const suggested = FALLBACK_MODELS.filter((candidate) =>
				authenticated.some((model) => model.provider === candidate.provider && model.id === candidate.model),
			).map((candidate) => `${candidate.provider}/${candidate.model}`);
			const others = authenticated
				.map((model) => `${model.provider}/${model.id}`)
				.filter((label) => !suggested.includes(label))
				.sort();

			const AUTO = "auto (first authenticated cheap model)";
			const CUSTOM = "enter provider/id…";
			const options = [AUTO, ...suggested, ...others, CUSTOM];
			const choice = await ctx.ui.select(`session-namer model (now: ${formatModelRef(pinned)})`, options);
			if (!choice) return;

			if (choice === AUTO) {
				pinModel(ctx, undefined);
				return;
			}

			const raw = choice === CUSTOM ? await ctx.ui.input("Model", "provider/id") : choice;
			if (!raw) return;
			const ref = parseModelRef(raw);
			if (!ref) {
				ctx.ui.notify("session-namer: expected provider/id", "warning");
				return;
			}
			pinModel(ctx, ref);
		},
	});

	pi.registerCommand("name-session", {
		description: "Auto-generate the session name now, or set it manually (usage: /name-session [name])",
		handler: async (args, ctx) => {
			const manual = args.trim();
			if (manual) {
				const name = sanitizeName(manual, config.maxNameLength);
				if (!name) {
					ctx.ui.notify("session-namer: empty name", "warning");
					return;
				}
				ownedName = undefined;
				manualName = true;
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
				return;
			}

			config = loadConfig();
			ctx.ui.notify("session-namer: generating…", "info");
			await maybeName(ctx, true);
			if (pi.getSessionName() === undefined) ctx.ui.notify("session-namer: could not generate a name", "warning");
		},
	});
}
