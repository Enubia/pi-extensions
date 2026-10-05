import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Config, parseConfig, type ThinkingLevel } from "../subagent-models/core.ts";
import {
	classifyFailure,
	type Cooldown,
	type FailoverState,
	type FailureKind,
	formatDuration,
	formatState,
	type ModelRef,
	parseResetAt,
	parseState,
	planFailover,
	planRestore,
	pruneCooldowns,
	withCooldown,
} from "./core.ts";

const STATE_FILE = "provider-failover-state.json";
const CONFIG_FILE = "subagent-models.json";
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const STATUS_KEY = "provider-failover";

interface Settings {
	enabled: boolean;
	retry: boolean;
	defaultCooldownMs: number;
	kinds: FailureKind[];
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
}

function settingsFor(cwd: string): Settings {
	const defaults: Settings = { enabled: true, retry: true, defaultCooldownMs: DEFAULT_COOLDOWN_MS, kinds: ["quota", "transient", "unavailable"] };
	for (const path of [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")]) {
		if (!existsSync(path)) continue;
		try {
			const block = (readJson(path) as Record<string, unknown>)["provider-failover"];
			if (typeof block !== "object" || block === null) continue;
			const record = block as Record<string, unknown>;
			if (typeof record.enabled === "boolean") defaults.enabled = record.enabled;
			if (typeof record.retry === "boolean") defaults.retry = record.retry;
			if (typeof record.defaultCooldownMinutes === "number") defaults.defaultCooldownMs = record.defaultCooldownMinutes * 60_000;
			if (Array.isArray(record.kinds)) defaults.kinds = record.kinds.filter((kind): kind is FailureKind => typeof kind === "string") as FailureKind[];
		} catch {}
	}
	return defaults;
}

function loadConfig(cwd: string): Config | undefined {
	for (const path of [join(cwd, ".pi", CONFIG_FILE), join(getAgentDir(), CONFIG_FILE)]) {
		if (!existsSync(path)) continue;
		try {
			return parseConfig(readJson(path));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function statePath(): string {
	return join(getAgentDir(), STATE_FILE);
}

function loadState(): FailoverState {
	try {
		return parseState(readJson(statePath()));
	} catch {
		return { cooldowns: {} };
	}
}

function saveState(state: FailoverState): void {
	const path = statePath();
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	renameSync(temp, path);
}

function isSubagent(): boolean {
	return Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
}

function currentRef(ctx: ExtensionContext): ModelRef | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

export default function providerFailover(pi: ExtensionAPI) {
	if (isSubagent()) return;

	let state = loadState();
	let lastResponse: { status: number; headers: Record<string, string>; at: number } | undefined;
	let pendingFailure: { model: ModelRef; message: string | undefined } | undefined;
	let switching = false;

	const setStatus = (ctx: ExtensionContext) => {
		const now = Date.now();
		const active = Object.entries(state.cooldowns).filter(([, cooldown]) => cooldown.until > now);
		if (active.length === 0 || !state.origin) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const soonest = active.reduce((min, [, cooldown]) => Math.min(min, cooldown.until), Number.POSITIVE_INFINITY);
		ctx.ui.setStatus(STATUS_KEY, `⇄ failover ${formatDuration(soonest - now)}`);
	};

	const persist = (ctx: ExtensionContext) => {
		state = pruneCooldowns(state, Date.now());
		saveState(state);
		setStatus(ctx);
	};

	const switchTo = async (ctx: ExtensionContext, target: ModelRef & { thinking?: ThinkingLevel }): Promise<boolean> => {
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return false;
		const ok = await pi.setModel(model);
		if (ok && target.thinking) pi.setThinkingLevel(target.thinking);
		return ok;
	};

	const restoreIfPossible = async (ctx: ExtensionContext) => {
		const current = currentRef(ctx);
		if (!current || switching) return;
		const target = planRestore(state, current, Date.now());
		if (!target) return;
		switching = true;
		try {
			if (await switchTo(ctx, target)) {
				ctx.ui.notify(`provider-failover: cooldown over, back on ${target.provider}/${target.id}`, "info");
				state = { cooldowns: state.cooldowns };
				persist(ctx);
			}
		} finally {
			switching = false;
		}
	};

	const handleFailure = async (ctx: ExtensionContext, message: string | undefined) => {
		const settings = settingsFor(ctx.cwd);
		if (!settings.enabled || switching) return;
		const current = currentRef(ctx);
		if (!current) return;

		const fresh = lastResponse && Date.now() - lastResponse.at < 60_000 ? lastResponse : undefined;
		const kind = classifyFailure({ status: fresh?.status, message });
		if (!settings.kinds.includes(kind)) return;

		const config = loadConfig(ctx.cwd);
		if (!config) {
			ctx.ui.notify(`provider-failover: ${CONFIG_FILE} missing or invalid — cannot pick a target`, "warning");
			return;
		}

		const now = Date.now();
		const until = (kind === "quota" ? parseResetAt(fresh?.headers, now) : undefined) ?? now + settings.defaultCooldownMs;
		const cooldown: Cooldown = { until, kind, reason: (message ?? "").slice(0, 120) };
		state = withCooldown(state, current.provider, cooldown);

		const target = planFailover(config, current, {
			now,
			state,
			isUsable: (ref) => {
				const model = ctx.modelRegistry.find(ref.provider, ref.id);
				return !!model && ctx.modelRegistry.hasConfiguredAuth(model);
			},
		});
		if (!target) {
			ctx.ui.notify(`provider-failover: ${current.provider} hit a ${kind} error and no fallback is available`, "error");
			persist(ctx);
			return;
		}

		switching = true;
		try {
			const origin = state.origin ?? { ...current, ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}) };
			if (!(await switchTo(ctx, target))) {
				ctx.ui.notify(`provider-failover: could not switch to ${target.provider}/${target.id}`, "error");
				persist(ctx);
				return;
			}
			state = { ...state, origin };
			persist(ctx);
			ctx.ui.notify(
				`provider-failover: ${current.provider}/${current.id} ${kind} → ${target.provider}/${target.id} (${target.tier}${target.downgraded ? ", downgraded" : ""}), back in ${formatDuration(until - now)}`,
				"warning",
			);

			const usage = ctx.getContextUsage();
			const window = ctx.modelRegistry.find(target.provider, target.id)?.contextWindow;
			if (usage?.tokens && window && usage.tokens > window * 0.9) ctx.compact();

			if (settings.retry) {
				pi.sendUserMessage(`The previous request failed with a ${kind} error on ${current.provider}. The session model is now ${target.provider}/${target.id}. Retry the last request from where it stopped.`, {
					deliverAs: "followUp",
				});
			}
		} finally {
			switching = false;
		}
	};

	pi.on("after_provider_response", async (event) => {
		lastResponse = { status: event.status, headers: event.headers, at: Date.now() };
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const model = currentRef(ctx);
		pendingFailure = message.stopReason === "error" && model ? { model, message: message.errorMessage } : undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const failure = pendingFailure;
		pendingFailure = undefined;
		if (!failure || event.outcome !== "error") return;
		const current = currentRef(ctx);
		if (current?.provider !== failure.model.provider || current.id !== failure.model.id) return;
		await handleFailure(ctx, failure.message);
	});

	pi.on("session_start", async (_event, ctx) => {
		pendingFailure = undefined;
		lastResponse = undefined;
		state = pruneCooldowns(loadState(), Date.now());
		setStatus(ctx);
		await restoreIfPossible(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await restoreIfPossible(ctx);
		setStatus(ctx);
	});

	pi.registerCommand("failover", {
		description: "Show provider-failover state, force a failover, or clear cooldowns (usage: /failover [now | clear | back])",
		handler: async (args, ctx) => {
			const argument = (args ?? "").trim();
			const current = currentRef(ctx);
			if (!current) {
				ctx.ui.notify("provider-failover: no active model", "warning");
				return;
			}

			if (argument === "clear") {
				state = { cooldowns: {} };
				persist(ctx);
				ctx.ui.notify("provider-failover: cooldowns cleared", "info");
				return;
			}

			if (argument === "back") {
				const origin = state.origin;
				if (!origin) {
					ctx.ui.notify("provider-failover: not failed over", "info");
					return;
				}
				state = { cooldowns: {}, origin };
				if (await switchTo(ctx, origin)) {
					state = { cooldowns: {} };
					persist(ctx);
					ctx.ui.notify(`provider-failover: back on ${origin.provider}/${origin.id}`, "info");
				} else ctx.ui.notify(`provider-failover: could not restore ${origin.provider}/${origin.id}`, "error");
				return;
			}

			if (argument === "now") {
				await handleFailure(ctx, "manual failover requested (quota)");
				return;
			}

			const settings = settingsFor(ctx.cwd);
			ctx.ui.notify(
				[...formatState(state, current, Date.now()), `Retry after switch: ${settings.retry ? "on" : "off"}`, `Enabled: ${settings.enabled ? "yes" : "no"}`, `Default cooldown: ${formatDuration(settings.defaultCooldownMs)}`].join("\n"),
				"info",
			);
		},
	});
}
