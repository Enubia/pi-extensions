import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	type Config,
	formatProfileSummary,
	formatResolution,
	formatRoleLine,
	formatTierLine,
	parseConfig,
	patchDefaultTier,
	patchRole,
	patchTier,
	type Resolution,
	resolveProfileName,
	resolveSpawnModel,
	type RoleSpec,
	type ThinkingLevel,
	THINKING_LEVELS,
	thinkingWarnings,
	type Tier,
	TIERS,
	type TierSpec,
} from "./core.ts";

const CONFIG_FILE = "subagent-models.json";

interface SubagentInput extends Record<string, unknown> {
	agent?: string;
	model?: string;
	name?: string;
}

interface AgentFrontmatter {
	model?: string;
	thinking?: string;
	cli?: string;
}

function configPath(cwd: string): string | undefined {
	const candidates = [join(cwd, ".pi", CONFIG_FILE), join(getAgentDir(), CONFIG_FILE)];
	return candidates.find((candidate) => existsSync(candidate));
}

function loadConfig(cwd: string): { config?: Config; path?: string; error?: string } {
	const path = configPath(cwd);
	if (!path) return { error: `no ${CONFIG_FILE} found` };
	try {
		return { config: parseConfig(JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""))), path };
	} catch (error) {
		return { path, error: `${path}: ${(error as Error).message}` };
	}
}

function writeConfig(path: string, contents: string): void {
	const temp = `${path}.subagent-models.tmp`;
	writeFileSync(temp, contents, "utf-8");
	renameSync(temp, path);
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : undefined;
}

function agentDirs(cwd: string): string[] {
	return [join(cwd, ".pi", "agents"), join(getAgentDir(), "agents")];
}

function readAgentFrontmatter(cwd: string, agent: string): AgentFrontmatter {
	for (const dir of agentDirs(cwd)) {
		const candidate = join(dir, `${agent}.md`);
		if (!existsSync(candidate)) continue;
		const match = readFileSync(candidate, "utf-8").match(/^---\n([\s\S]*?)\n---/);
		if (!match) continue;
		return {
			model: frontmatterValue(match[1], "model"),
			thinking: frontmatterValue(match[1], "thinking"),
			cli: frontmatterValue(match[1], "cli"),
		};
	}
	return {};
}

function discoverAgents(cwd: string): string[] {
	const names = new Set<string>();
	for (const dir of agentDirs(cwd)) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) if (file.endsWith(".md")) names.add(file.replace(/\.md$/, ""));
	}
	return [...names].sort();
}

function isSubagent(): boolean {
	return Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
}

const BACK = "← back";

function splitRef(model: string): { provider?: string; id: string } {
	const slash = model.indexOf("/");
	return slash === -1 ? { id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export default function subagentModels(pi: ExtensionAPI) {
	let pinned: string | undefined;
	const announced = new Set<string>();

	const resolveProfile = (ctx: ExtensionContext, config: Config) => resolveProfileName(config, { provider: ctx.model?.provider, pinned });

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType<"subagent", SubagentInput>("subagent", event)) return;
		if (isSubagent()) return;

		const { config, error } = loadConfig(ctx.cwd);
		if (!config) {
			if (error && !announced.has(error)) {
				announced.add(error);
				ctx.ui.notify(`subagent-models: ${error}`, "warning");
			}
			return;
		}

		const input = event.input;
		const agent = typeof input.agent === "string" ? input.agent : undefined;
		const frontmatter = agent ? readAgentFrontmatter(ctx.cwd, agent) : {};
		const profile = resolveProfile(ctx, config);
		const resolution: Resolution = resolveSpawnModel(config, {
			profileName: profile.name,
			agent,
			requestedModel: typeof input.model === "string" ? input.model : undefined,
			agentModel: frontmatter.model,
			agentThinking: frontmatter.thinking,
			agentCli: frontmatter.cli,
		});
		if (resolution.action !== "set") return;

		input.model = resolution.model;
		const line = `subagent-models [${profile.name}] ${formatResolution(agent, resolution)}`;
		if (!announced.has(line)) {
			announced.add(line);
			ctx.ui.notify(line, "info");
		}
	});

	const supportedLevels = (ctx: ExtensionCommandContext | ExtensionContext, model: string): readonly string[] | undefined => {
		const { provider, id } = splitRef(model.trim());
		if (!provider) return undefined;
		const found = ctx.modelRegistry.find(provider, id);
		if (!found) return undefined;
		return found.reasoning ? getSupportedThinkingLevels(found) : ["off"];
	};

	const pickThinking = async (
		ctx: ExtensionCommandContext,
		current: ThinkingLevel | undefined,
		inheritLabel: string,
		model?: string,
	): Promise<ThinkingLevel | undefined | null> => {
		const available = model ? supportedLevels(ctx, model) : undefined;
		const levels = THINKING_LEVELS.filter((level) => !available || available.includes(level));
		const INHERIT = `${inheritLabel}${current ? "" : " (current)"}`;
		const title = model && available ? `Thinking level — ${splitRef(model).id} supports: ${available.join(", ")}` : "Thinking level";
		const choice = await ctx.ui.select(title, [INHERIT, ...levels.map((level) => `${level}${level === current ? " (current)" : ""}`)]);
		if (choice === undefined) return null;
		if (choice === INHERIT) return undefined;
		return choice.replace(/ \(current\)$/, "") as ThinkingLevel;
	};

	const editRoles = async (ctx: ExtensionCommandContext, config: Config, path: string, profileName: string): Promise<boolean> => {
		const names = [...new Set([...Object.keys(config.roles), ...discoverAgents(ctx.cwd)])].sort();
		const labels = names.map((name) => formatRoleLine(name, config.roles[name], config, profileName));
		const OTHER = "+ other role name…";
		const choice = await ctx.ui.select(`Roles (agent name → tier), profile ${profileName}`, [...labels, OTHER, BACK]);
		if (choice === undefined || choice === BACK) return false;

		const role = choice === OTHER ? (await ctx.ui.input("Role / agent name", "worker"))?.trim() : names[labels.indexOf(choice)];
		if (!role) return false;

		const current = config.roles[role];
		const REMOVE = "(unmapped — use the agent's own model)";
		const tierChoice = await ctx.ui.select(
			`${role} → tier`,
			[...TIERS.map((tier) => `${tier}${tier === current?.tier ? " (current)" : ""}`), REMOVE, BACK],
		);
		if (tierChoice === undefined || tierChoice === BACK) return false;

		let spec: RoleSpec | undefined;
		if (tierChoice !== REMOVE) {
			const tier = tierChoice.replace(/ \(current\)$/, "") as Tier;
			const thinking = await pickThinking(ctx, current?.thinking, "inherit from tier", config.profiles[profileName]?.tiers[tier]?.model);
			if (thinking === null) return false;
			spec = thinking ? { tier, thinking } : { tier };
		}

		try {
			writeConfig(path, patchRole(readFileSync(path, "utf-8"), role, spec));
		} catch (error) {
			ctx.ui.notify(`subagent-models: ${(error as Error).message}`, "error");
			return false;
		}
		ctx.ui.notify(spec ? `subagent-models: ${role} → ${spec.tier}${spec.thinking ? `:${spec.thinking}` : ""}` : `subagent-models: ${role} unmapped`, "info");
		return true;
	};

	const editDefaultTier = async (ctx: ExtensionCommandContext, config: Config, path: string): Promise<boolean> => {
		const profileNames = Object.keys(config.profiles);
		const profileChoice = profileNames.length === 1 ? profileNames[0] : await ctx.ui.select("Profile to edit", [...profileNames, BACK]);
		if (profileChoice === undefined || profileChoice === BACK) return false;
		const profile = config.profiles[profileChoice];
		const choices = TIERS.filter((tier) => profile.tiers[tier]).map((tier) => {
			const spec = profile.tiers[tier]!;
			return `${formatTierLine(tier, spec)}${tier === profile.defaultTier ? " (current)" : ""}`;
		});
		const choice = await ctx.ui.select(`${profile.name} default tier — now: ${profile.defaultTier ?? "(unset)"}`, [...choices, BACK]);
		if (choice === undefined || choice === BACK) return false;
		const tier = TIERS.find((candidate) => choice === `${formatTierLine(candidate, profile.tiers[candidate])}${candidate === profile.defaultTier ? " (current)" : ""}`);
		if (!tier) return false;
		try {
			writeConfig(path, patchDefaultTier(readFileSync(path, "utf-8"), profile.name, tier));
		} catch (error) {
			ctx.ui.notify(`subagent-models: ${(error as Error).message}`, "error");
			return false;
		}
		ctx.ui.notify(`subagent-models: ${profile.name} default tier → ${tier}`, "info");
		return true;
	};

	const editTiers = async (ctx: ExtensionCommandContext, config: Config, path: string): Promise<boolean> => {
		const profileNames = Object.keys(config.profiles);
		const profileChoice = profileNames.length === 1 ? profileNames[0] : await ctx.ui.select("Profile to edit", [...profileNames, BACK]);
		if (profileChoice === undefined || profileChoice === BACK) return false;
		const profile = config.profiles[profileChoice];

		const labels = TIERS.map((tier) => formatTierLine(tier, profile.tiers[tier]));
		const tierChoice = await ctx.ui.select(`${profile.name} tiers (${profile.providers.join(", ")})`, [...labels, BACK]);
		if (tierChoice === undefined || tierChoice === BACK) return false;
		const tier = TIERS[labels.indexOf(tierChoice)];
		const current = profile.tiers[tier];

		const authenticated = ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
		const matching = authenticated
			.filter((model) => profile.providers.includes(model.provider))
			.map((model) => `${model.provider}/${model.id}`)
			.sort();
		const others = authenticated
			.map((model) => `${model.provider}/${model.id}`)
			.filter((label) => !matching.includes(label))
			.sort();
		const CUSTOM = "enter provider/id…";
		const REMOVE = "(unset this tier)";
		const modelChoice = await ctx.ui.select(`${profile.name} / ${tier} — now: ${current?.model ?? "unset"}`, [...matching, ...others, CUSTOM, REMOVE, BACK]);
		if (modelChoice === undefined || modelChoice === BACK) return false;

		let spec: TierSpec | undefined;
		if (modelChoice !== REMOVE) {
			const model = (modelChoice === CUSTOM ? await ctx.ui.input("Model", "provider/id") : modelChoice)?.trim();
			if (!model) return false;
			const thinking = await pickThinking(ctx, current?.thinking, "none (session default)", model);
			if (thinking === null) return false;
			spec = thinking ? { model, thinking } : { model };
		}

		try {
			writeConfig(path, patchTier(readFileSync(path, "utf-8"), profile.name, tier, spec));
		} catch (error) {
			ctx.ui.notify(`subagent-models: ${(error as Error).message}`, "error");
			return false;
		}
		ctx.ui.notify(spec ? `subagent-models: ${profile.name}/${tier} → ${spec.model}${spec.thinking ? `:${spec.thinking}` : ""}` : `subagent-models: ${profile.name}/${tier} unset`, "info");
		return true;
	};

	pi.registerCommand("subagent-models", {
		description: "Show, pin, or edit the subagent model profiles (usage: /subagent-models [profile | auto | edit])",
		handler: async (args, ctx) => {
			const argument = (args ?? "").trim();

			const reload = () => {
				const loaded = loadConfig(ctx.cwd);
				if (!loaded.config) ctx.ui.notify(`subagent-models: ${loaded.error}`, "error");
				return loaded;
			};

			let { config, path } = reload();
			if (!config || !path) return;

			const names = Object.keys(config.profiles);
			const summary = () => {
				const active = config as Config;
				const profile = resolveProfileName(active, { provider: ctx.model?.provider, pinned });
				const warnings = thinkingWarnings(active, profile.name, (model) => supportedLevels(ctx, model));
				ctx.ui.notify(
					[...formatProfileSummary(active, profile.name, ctx.model?.provider, profile.source), ...(warnings.length ? ["", ...warnings.map((line) => `! ${line}`)] : []), "", path as string].join("\n"),
					warnings.length ? "warning" : "info",
				);
			};

			if (argument.length > 0 && argument !== "edit") {
				if (argument === "auto") pinned = undefined;
				else if (names.includes(argument)) pinned = argument;
				else {
					ctx.ui.notify(`subagent-models: unknown profile "${argument}" (known: auto, edit, ${names.join(", ")})`, "error");
					return;
				}
				announced.clear();
				summary();
				return;
			}

			if (!ctx.hasUI) {
				summary();
				return;
			}

			for (;;) {
				const active = resolveProfileName(config, { provider: ctx.model?.provider, pinned });
				const PIN = `Pin profile… (now: ${active.name}, ${active.source})`;
				const ROLES = "Edit roles (agent → tier)…";
				const TIERS_ITEM = "Edit tiers (tier → model)…";
				const DEFAULT_ITEM = "Edit default tier…";
				const SHOW = "Show resolved profile";
				const CLOSE = "Close";
				const choice = await ctx.ui.select("subagent-models", [SHOW, PIN, ROLES, TIERS_ITEM, DEFAULT_ITEM, CLOSE]);
				if (choice === undefined || choice === CLOSE) return;

				if (choice === SHOW) {
					summary();
					return;
				}

				if (choice === PIN) {
					const AUTO = `auto (session provider${ctx.model?.provider ? `: ${ctx.model.provider}` : ""})`;
					const pick = await ctx.ui.select("Pin subagent model profile", [AUTO, ...names, BACK]);
					if (pick === undefined || pick === BACK) continue;
					pinned = pick === AUTO ? undefined : pick;
					announced.clear();
					summary();
					return;
				}

				const changed = choice === ROLES ? await editRoles(ctx, config, path, active.name) : choice === DEFAULT_ITEM ? await editDefaultTier(ctx, config, path) : await editTiers(ctx, config, path);
				if (changed) {
					announced.clear();
					const reloaded = reload();
					if (!reloaded.config || !reloaded.path) return;
					config = reloaded.config;
					path = reloaded.path;
				}
			}
		},
	});
}
