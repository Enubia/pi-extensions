export const TIERS = ["cheapest", "cheap", "standard", "capable", "frontier"] as const;

export type Tier = (typeof TIERS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface TierSpec {
	model: string;
	thinking?: ThinkingLevel;
}

export interface Profile {
	name: string;
	providers: string[];
	defaultTier?: Tier;
	tiers: Partial<Record<Tier, TierSpec>>;
}

export interface RoleSpec {
	tier: Tier;
	thinking?: ThinkingLevel;
}

export interface Config {
	fallbackProfile: string;
	roles: Record<string, RoleSpec>;
	profiles: Record<string, Profile>;
}

export interface SpawnRequest {
	profileName: string;
	agent?: string;
	requestedModel?: string;
	agentModel?: string;
	agentThinking?: string;
	agentCli?: string;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type Resolution =
	| { action: "skip"; reason: string }
	| { action: "set"; model: string; tier: Tier; source: "explicit-tier" | "requested-model" | "role" | "agent-model" | "profile-default"; previous?: string };

function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} must be an object`);
	return value as Record<string, unknown>;
}

function parseRole(name: string, raw: unknown): RoleSpec {
	if (isTier(raw)) return { tier: raw };
	if (typeof raw === "string") throw new Error(`role "${name}" has an unknown tier: ${JSON.stringify(raw)}`);
	const record = asRecord(raw, `role "${name}"`);
	const tier = record.tier;
	if (!isTier(tier)) throw new Error(`role "${name}" has an unknown tier: ${JSON.stringify(tier)}`);
	const thinking = record.thinking;
	if (thinking !== undefined && !isThinkingLevel(thinking)) throw new Error(`role "${name}" has an unknown thinking level: ${JSON.stringify(thinking)}`);
	return thinking === undefined ? { tier } : { tier, thinking };
}

function parseProfile(name: string, raw: unknown): Profile {
	const record = asRecord(raw, `profile "${name}"`);
	const providers = record.providers;
	if (!Array.isArray(providers) || providers.some((p) => typeof p !== "string") || providers.length === 0) {
		throw new Error(`profile "${name}" needs a non-empty providers array`);
	}
	const defaultTier = record.defaultTier;
	if (defaultTier !== undefined && !isTier(defaultTier)) throw new Error(`profile "${name}" has an unknown defaultTier`);
	const tiers: Partial<Record<Tier, TierSpec>> = {};
	for (const [tierName, spec] of Object.entries(asRecord(record.tiers, `profile "${name}" tiers`))) {
		if (!isTier(tierName)) throw new Error(`profile "${name}" has an unknown tier: ${tierName}`);
		const tierRecord = asRecord(spec, `profile "${name}" tier "${tierName}"`);
		if (typeof tierRecord.model !== "string" || tierRecord.model.trim().length === 0) {
			throw new Error(`profile "${name}" tier "${tierName}" needs a model`);
		}
		const thinking = tierRecord.thinking;
		if (thinking !== undefined && !isThinkingLevel(thinking)) {
			throw new Error(`profile "${name}" tier "${tierName}" has an unknown thinking level: ${JSON.stringify(thinking)}`);
		}
		tiers[tierName] = thinking === undefined ? { model: tierRecord.model.trim() } : { model: tierRecord.model.trim(), thinking };
	}
	if (Object.keys(tiers).length === 0) throw new Error(`profile "${name}" has no tiers`);
	return { name, providers: providers as string[], defaultTier: defaultTier as Tier | undefined, tiers };
}

export function parseConfig(raw: unknown): Config {
	const record = asRecord(raw, "subagent-models.json");
	const profiles: Record<string, Profile> = {};
	for (const [name, spec] of Object.entries(asRecord(record.profiles, "profiles"))) profiles[name] = parseProfile(name, spec);
	if (Object.keys(profiles).length === 0) throw new Error("subagent-models.json has no profiles");

	const roles: Record<string, RoleSpec> = {};
	if (record.roles !== undefined) {
		for (const [name, spec] of Object.entries(asRecord(record.roles, "roles"))) roles[name] = parseRole(name, spec);
	}

	const fallbackProfile = record.fallbackProfile;
	if (typeof fallbackProfile !== "string" || !profiles[fallbackProfile]) {
		throw new Error(`fallbackProfile must name a configured profile, got ${JSON.stringify(fallbackProfile)}`);
	}
	return { fallbackProfile, roles, profiles };
}

export function splitModelRef(model: string): { id: string; thinking?: string } {
	const trimmed = model.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0) return { id: trimmed };
	return { id: trimmed.slice(0, colon), thinking: trimmed.slice(colon + 1) };
}

function bareId(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return (slash === -1 ? modelId : modelId.slice(slash + 1)).toLowerCase();
}

export function resolveProfileName(config: Config, opts: { provider?: string; pinned?: string }): { name: string; source: "pinned" | "provider" | "fallback" } {
	if (opts.pinned && config.profiles[opts.pinned]) return { name: opts.pinned, source: "pinned" };
	if (opts.provider) {
		for (const profile of Object.values(config.profiles)) {
			if (profile.providers.includes(opts.provider)) return { name: profile.name, source: "provider" };
		}
	}
	return { name: config.fallbackProfile, source: "fallback" };
}

export function findTier(config: Config, model: string): { profile: string; tier: Tier } | undefined {
	const { id } = splitModelRef(model);
	const wanted = id.toLowerCase();
	const wantedBare = bareId(id);
	let bareMatch: { profile: string; tier: Tier } | undefined;
	for (const profile of Object.values(config.profiles)) {
		for (const [tier, spec] of Object.entries(profile.tiers) as [Tier, TierSpec][]) {
			const candidate = splitModelRef(spec.model).id.toLowerCase();
			if (candidate === wanted) return { profile: profile.name, tier };
			if (!bareMatch && bareId(candidate) === wantedBare) bareMatch = { profile: profile.name, tier };
		}
	}
	return bareMatch;
}

export function parseTierToken(value: string | undefined): Tier | undefined {
	if (!value) return undefined;
	const token = value.trim().toLowerCase().replace(/^tier[:/]/, "");
	return isTier(token) ? token : undefined;
}

export function resolveSpawnModel(config: Config, request: SpawnRequest): Resolution {
	const profile = config.profiles[request.profileName];
	if (!profile) return { action: "skip", reason: `unknown profile "${request.profileName}"` };
	if (request.agentCli) return { action: "skip", reason: `agent runs the ${request.agentCli} CLI` };

	const previous = request.requestedModel ?? request.agentModel;
	let tier: Tier | undefined;
	let source: Extract<Resolution, { action: "set" }>["source"] | undefined;
	let roleThinking: string | undefined;

	const explicitTier = parseTierToken(request.requestedModel);
	if (explicitTier) {
		tier = explicitTier;
		source = "explicit-tier";
	}

	if (!tier && request.requestedModel) {
		const found = findTier(config, request.requestedModel);
		if (found) {
			tier = found.tier;
			source = "requested-model";
		} else {
			return { action: "skip", reason: `explicit model "${request.requestedModel}" is not in any profile` };
		}
	}

	if (!tier && request.agent) {
		const role = config.roles[request.agent];
		if (role) {
			tier = role.tier;
			roleThinking = role.thinking;
			source = "role";
		}
	}

	if (!tier && request.agentModel) {
		const found = findTier(config, request.agentModel);
		if (found) {
			tier = found.tier;
			source = "agent-model";
		}
	}

	if (!tier && !previous && profile.defaultTier) {
		tier = profile.defaultTier;
		source = "profile-default";
	}

	if (!tier || !source) return { action: "skip", reason: previous ? `no tier known for "${previous}"` : "no agent model, role, or tier to map" };

	const spec = profile.tiers[tier];
	if (!spec) return { action: "skip", reason: `profile "${profile.name}" has no "${tier}" tier` };

	const thinking = request.agentThinking ? undefined : (roleThinking ?? spec.thinking);
	const model = thinking ? `${spec.model}:${thinking}` : spec.model;
	if (previous && splitModelRef(previous).id === splitModelRef(model).id) {
		return { action: "skip", reason: `already ${splitModelRef(model).id}` };
	}
	return previous ? { action: "set", model, tier, source, previous } : { action: "set", model, tier, source };
}

export function formatProfileSummary(config: Config, profileName: string, provider: string | undefined, source: "pinned" | "provider" | "fallback"): string[] {
	const profile = config.profiles[profileName];
	if (!profile) return [`subagent-models: unknown profile "${profileName}"`];
	const lines = [`Profile: ${profile.name} (${source}${provider ? `, session provider ${provider}` : ""})`, `Default tier: ${profile.defaultTier ?? "(unset)"}`, ""];
	for (const tier of TIERS) {
		const spec = profile.tiers[tier];
		if (!spec) continue;
		const roles = Object.entries(config.roles)
			.filter(([, role]) => role.tier === tier)
			.map(([name]) => name);
		const thinking = spec.thinking ? `:${spec.thinking}` : "";
		lines.push(`${tier.padEnd(9)} ${spec.model}${thinking}${roles.length ? `  ← ${roles.join(", ")}` : ""}`);
	}
	return lines;
}

function reserialize(raw: string, mutate: (draft: Record<string, unknown>) => void): string {
	const draft = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
	mutate(draft);
	parseConfig(draft);
	return `${JSON.stringify(draft, null, 2)}\n`;
}

export function patchRole(raw: string, role: string, spec: RoleSpec | undefined): string {
	if (role.trim().length === 0) throw new Error("role name must not be empty");
	return reserialize(raw, (draft) => {
		const roles = (typeof draft.roles === "object" && draft.roles !== null && !Array.isArray(draft.roles) ? draft.roles : {}) as Record<string, unknown>;
		if (!spec) delete roles[role];
		else roles[role] = spec.thinking ? { tier: spec.tier, thinking: spec.thinking } : spec.tier;
		draft.roles = roles;
	});
}

export function patchDefaultTier(raw: string, profileName: string, tier: Tier): string {
	return reserialize(raw, (draft) => {
		const profiles = asRecord(draft.profiles, "profiles");
		const profile = asRecord(profiles[profileName], `profile "${profileName}"`);
		if (!isTier(tier)) throw new Error(`profile "${profileName}" has an unknown tier`);
		const tiers = asRecord(profile.tiers, `profile "${profileName}" tiers`);
		if (!tiers[tier]) throw new Error(`profile "${profileName}" has no "${tier}" tier`);
		profile.defaultTier = tier;
	});
}

export function patchTier(raw: string, profileName: string, tier: Tier, spec: TierSpec | undefined): string {
	return reserialize(raw, (draft) => {
		const profiles = asRecord(draft.profiles, "profiles");
		const profile = asRecord(profiles[profileName], `profile "${profileName}"`);
		const tiers = asRecord(profile.tiers, `profile "${profileName}" tiers`);
		if (!spec) delete tiers[tier];
		else tiers[tier] = spec.thinking ? { model: spec.model, thinking: spec.thinking } : { model: spec.model };
		profile.tiers = tiers;
		profiles[profileName] = profile;
		draft.profiles = profiles;
	});
}

export function formatRoleLine(name: string, spec: RoleSpec | undefined, config: Config, profileName: string): string {
	if (!spec) return `${name.padEnd(16)} (unmapped)`;
	const target = config.profiles[profileName]?.tiers[spec.tier];
	const thinking = spec.thinking ?? target?.thinking;
	return `${name.padEnd(16)} ${spec.tier.padEnd(9)} ${target ? `${target.model}${thinking ? `:${thinking}` : ""}` : "(tier missing in profile)"}`;
}

export type ThinkingSupport = (model: string) => readonly string[] | undefined;

export function thinkingWarnings(config: Config, profileName: string, supported: ThinkingSupport): string[] {
	const profile = config.profiles[profileName];
	if (!profile) return [];
	const warnings: string[] = [];
	for (const tier of TIERS) {
		const spec = profile.tiers[tier];
		if (!spec) continue;
		const levels = supported(splitModelRef(spec.model).id);
		if (!levels) {
			warnings.push(`${tier}: ${spec.model} is not in the model registry`);
			continue;
		}
		const wanted = new Set<string>();
		if (spec.thinking) wanted.add(spec.thinking);
		for (const [role, roleSpec] of Object.entries(config.roles)) {
			if (roleSpec.tier === tier && roleSpec.thinking) wanted.add(`${roleSpec.thinking}\u0000${role}`);
		}
		for (const entry of wanted) {
			const [level, role] = entry.split("\u0000");
			if (levels.includes(level)) continue;
			warnings.push(`${tier}: ${splitModelRef(spec.model).id} does not support "${level}"${role ? ` (role ${role})` : ""} — pi will clamp it`);
		}
	}
	return warnings;
}

export function formatTierLine(tier: Tier, spec: TierSpec | undefined): string {
	return `${tier.padEnd(9)} ${spec ? `${spec.model}${spec.thinking ? `:${spec.thinking}` : ""}` : "(unset)"}`;
}

export function formatResolution(agent: string | undefined, resolution: Resolution): string {
	const who = agent ? `${agent}` : "subagent";
	if (resolution.action === "skip") return `${who}: unchanged (${resolution.reason})`;
	return `${who}: ${resolution.previous ?? "—"} → ${resolution.model} (${resolution.tier}, via ${resolution.source})`;
}
