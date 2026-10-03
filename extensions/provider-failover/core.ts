import { type Config, findTier, type ThinkingLevel, type Tier, TIERS } from "../subagent-models/core.ts";

export type FailureKind = "quota" | "transient" | "unavailable" | "ignore";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface Cooldown {
	until: number;
	kind: FailureKind;
	reason: string;
}

export type Cooldowns = Record<string, Cooldown>;

export interface FailoverState {
	cooldowns: Cooldowns;
	origin?: ModelRef & { thinking?: ThinkingLevel };
}

const QUOTA_PATTERNS = [
	/usage limit/i,
	/quota/i,
	/rate.?limit/i,
	/too many requests/i,
	/insufficient[_ ]quota/i,
	/billing/i,
	/credit balance/i,
	/plan limit/i,
	/upgrade to continue/i,
];

const TRANSIENT_PATTERNS = [/overloaded/i, /capacity/i, /timeout/i, /timed out/i, /ECONNRESET/i, /ETIMEDOUT/i, /fetch failed/i, /socket hang up/i, /internal server error/i, /bad gateway/i, /service unavailable/i];

const UNAVAILABLE_PATTERNS = [/not[_ ]found/i, /is not available/i, /does not exist/i, /unsupported model/i, /invalid model/i, /model.*deprecated/i];

const IGNORE_PATTERNS = [/aborted/i, /context (window|length)/i, /prompt is too long/i, /maximum context/i, /user cancell?ed/i];

export function classifyFailure(input: { status?: number; message?: string }): FailureKind {
	const message = input.message ?? "";
	if (IGNORE_PATTERNS.some((pattern) => pattern.test(message))) return "ignore";
	if (input.status === 429) return "quota";
	if (input.status === 402 || input.status === 403) return QUOTA_PATTERNS.some((pattern) => pattern.test(message)) ? "quota" : "ignore";
	if (input.status === 404) return "unavailable";
	if (input.status === 529 || (input.status !== undefined && input.status >= 500)) return "transient";
	if (QUOTA_PATTERNS.some((pattern) => pattern.test(message))) return "quota";
	if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) return "unavailable";
	if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
	return "ignore";
}

const RESET_HEADERS = [
	"retry-after",
	"anthropic-ratelimit-unified-reset",
	"anthropic-ratelimit-unified-5h-reset",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-reset",
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
	"x-codex-primary-reset-after-seconds",
	"x-codex-secondary-reset-after-seconds",
];

function parseDuration(value: string): number | undefined {
	const compound = value.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/i);
	if (compound && compound.slice(1).some((part) => part !== undefined)) {
		const [hours, minutes, seconds, millis] = compound.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
		const total = hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
		return total > 0 ? total : undefined;
	}
	return undefined;
}

export function parseResetAt(headers: Record<string, string> | undefined, now: number): number | undefined {
	if (!headers) return undefined;
	const lookup: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) lookup[key.toLowerCase()] = value;

	for (const header of RESET_HEADERS) {
		const raw = lookup[header]?.trim();
		if (!raw) continue;

		const numeric = Number(raw);
		if (Number.isFinite(numeric)) {
			if (numeric <= 0) continue;
			if (numeric > 1_000_000_000) return numeric * 1000;
			return now + numeric * 1000;
		}

		const duration = parseDuration(raw);
		if (duration !== undefined) return now + duration;

		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	return undefined;
}

export function profileOf(config: Config, provider: string): string | undefined {
	for (const profile of Object.values(config.profiles)) if (profile.providers.includes(provider)) return profile.name;
	return undefined;
}

export function isCoolingDown(state: FailoverState, provider: string, now: number): boolean {
	const cooldown = state.cooldowns[provider];
	return cooldown !== undefined && cooldown.until > now;
}

export function pruneCooldowns(state: FailoverState, now: number): FailoverState {
	const cooldowns: Cooldowns = {};
	for (const [provider, cooldown] of Object.entries(state.cooldowns)) if (cooldown.until > now) cooldowns[provider] = cooldown;
	return state.origin ? { cooldowns, origin: state.origin } : { cooldowns };
}

function tiersFrom(tier: Tier): Tier[] {
	const index = TIERS.indexOf(tier);
	return [tier, ...TIERS.slice(0, index).reverse(), ...TIERS.slice(index + 1)];
}

export interface PlanOptions {
	now: number;
	state: FailoverState;
	isUsable: (ref: ModelRef) => boolean;
}

export interface FailoverTarget extends ModelRef {
	tier: Tier;
	thinking?: ThinkingLevel;
	profile: string;
	downgraded: boolean;
}

function refOf(model: string): ModelRef | undefined {
	const slash = model.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export function planFailover(config: Config, current: ModelRef, options: PlanOptions): FailoverTarget | undefined {
	const currentProfile = profileOf(config, current.provider);
	const found = findTier(config, `${current.provider}/${current.id}`);
	const tier = found?.tier ?? config.profiles[currentProfile ?? config.fallbackProfile]?.defaultTier ?? "standard";

	const names = Object.keys(config.profiles);
	const startIndex = currentProfile ? names.indexOf(currentProfile) : -1;
	const ordered = [...names.slice(startIndex + 1), ...names.slice(0, Math.max(startIndex, 0) + (startIndex === -1 ? 0 : 1))];

	for (const name of ordered) {
		if (name === currentProfile) continue;
		const profile = config.profiles[name];
		if (profile.providers.every((provider) => isCoolingDown(options.state, provider, options.now))) continue;

		for (const candidateTier of tiersFrom(tier)) {
			const spec = profile.tiers[candidateTier];
			if (!spec) continue;
			const ref = refOf(spec.model);
			if (!ref) continue;
			if (ref.provider === current.provider && ref.id === current.id) continue;
			if (isCoolingDown(options.state, ref.provider, options.now)) continue;
			if (!options.isUsable(ref)) continue;
			return {
				...ref,
				tier: candidateTier,
				profile: name,
				downgraded: candidateTier !== tier,
				...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
			};
		}
	}
	return undefined;
}

export function planRestore(state: FailoverState, current: ModelRef, now: number): (ModelRef & { thinking?: ThinkingLevel }) | undefined {
	const origin = state.origin;
	if (!origin) return undefined;
	if (origin.provider === current.provider && origin.id === current.id) return undefined;
	if (isCoolingDown(state, origin.provider, now)) return undefined;
	return origin;
}

export function withCooldown(state: FailoverState, provider: string, cooldown: Cooldown): FailoverState {
	return { ...state, cooldowns: { ...state.cooldowns, [provider]: cooldown } };
}

export function parseState(raw: unknown): FailoverState {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { cooldowns: {} };
	const record = raw as Record<string, unknown>;
	const cooldowns: Cooldowns = {};
	if (typeof record.cooldowns === "object" && record.cooldowns !== null) {
		for (const [provider, value] of Object.entries(record.cooldowns as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const entry = value as Record<string, unknown>;
			if (typeof entry.until !== "number") continue;
			cooldowns[provider] = {
				until: entry.until,
				kind: (typeof entry.kind === "string" ? entry.kind : "quota") as FailureKind,
				reason: typeof entry.reason === "string" ? entry.reason : "",
			};
		}
	}
	const origin = record.origin as Record<string, unknown> | undefined;
	if (origin && typeof origin.provider === "string" && typeof origin.id === "string") {
		return {
			cooldowns,
			origin: {
				provider: origin.provider,
				id: origin.id,
				...(typeof origin.thinking === "string" ? { thinking: origin.thinking as ThinkingLevel } : {}),
			},
		};
	}
	return { cooldowns };
}

export function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

export function formatState(state: FailoverState, current: ModelRef, now: number): string[] {
	const lines = [`Active: ${current.provider}/${current.id}`];
	if (state.origin) lines.push(`Origin: ${state.origin.provider}/${state.origin.id}${state.origin.thinking ? `:${state.origin.thinking}` : ""}`);
	const cooldowns = Object.entries(state.cooldowns).filter(([, cooldown]) => cooldown.until > now);
	if (cooldowns.length === 0) lines.push("Cooldowns: none");
	else for (const [provider, cooldown] of cooldowns) lines.push(`Cooldown: ${provider} for ${formatDuration(cooldown.until - now)} (${cooldown.kind}${cooldown.reason ? `: ${cooldown.reason}` : ""})`);
	return lines;
}
