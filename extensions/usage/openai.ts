import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export async function hasChatGPTOAuth(registry: Pick<ModelRegistry, "getProviderAuth">): Promise<boolean> {
	const resolution = await registry.getProviderAuth("openai");
	return resolution?.source === "OAuth" && Boolean(resolution.auth.apiKey);
}

export type UsageWindow = {
	name: "Primary" | "Secondary";
	usedPercent?: number;
	remainingPercent?: number;
	durationMinutes?: number;
	resetsAt?: number;
};

export type UsageCredits = {
	hasCredits?: boolean;
	unlimited?: boolean;
	balance?: string;
};

export type SpendControl = {
	reached?: boolean;
	limit?: string;
	used?: string;
	remainingPercent?: number;
	resetsAt?: number;
};

export type UsageBucket = {
	id: string;
	name?: string;
	allowed?: boolean;
	limitReached?: boolean;
	windows: UsageWindow[];
	credits?: UsageCredits;
	spendControl?: SpendControl;
	reachedType?: string;
};

export type SubscriptionUsage = {
	planType?: string;
	fetchedAt: number;
	buckets: UsageBucket[];
};

type UsageErrorCode = "not-authenticated" | "unauthorized" | "timeout" | "invalid-response" | "backend";

const CODEX_PROVIDER = "openai-codex";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

type CodexOAuthRegistry = {
	getAll(): readonly { provider: string }[];
	isUsingOAuth(model: { provider: string }): boolean;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")));
		const accountId = record(record(payload)?.[CODEX_AUTH_CLAIM])?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveCodexOAuthAuth(registry: CodexOAuthRegistry): Promise<{ accessToken: string; accountId: string } | undefined> {
	const model = registry.getAll().find((candidate) => candidate.provider === CODEX_PROVIDER);
	if (!model || !registry.isUsingOAuth(model)) return undefined;
	const accessToken = await registry.getApiKeyForProvider(CODEX_PROVIDER);
	const accountId = accessToken === undefined ? undefined : codexAccountId(accessToken);
	return accessToken && accountId ? { accessToken, accountId } : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentage(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number >= 0 && number <= 100 ? number : undefined;
}

function positive(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number > 0 ? number : undefined;
}

function unixSeconds(value: unknown): number | undefined {
	const seconds = positive(value);
	if (seconds === undefined) return undefined;
	return Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined;
}

function normalizeWindow(value: unknown, name: UsageWindow["name"]): UsageWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const usedPercent = percentage(source.used_percent);
	const seconds = positive(source.limit_window_seconds);
	const resetsAt = unixSeconds(source.reset_at);
	return {
		name,
		...(usedPercent === undefined ? {} : { usedPercent, remainingPercent: 100 - usedPercent }),
		...(seconds === undefined ? {} : { durationMinutes: Math.ceil(seconds / 60) }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function normalizeCredits(value: unknown): UsageCredits | undefined {
	const source = record(value);
	if (!source) return undefined;
	const hasCredits = boolean(source.has_credits);
	const unlimited = boolean(source.unlimited);
	const balance = text(source.balance);
	if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined;
	return {
		...(hasCredits === undefined ? {} : { hasCredits }),
		...(unlimited === undefined ? {} : { unlimited }),
		...(balance === undefined ? {} : { balance }),
	};
}

function normalizeSpendControl(value: unknown): SpendControl | undefined {
	const source = record(value);
	if (!source) return undefined;
	const individual = record(source.individual_limit);
	const reached = boolean(source.reached);
	const limit = text(individual?.limit);
	const used = text(individual?.used);
	const remainingPercent = percentage(individual?.remaining_percent);
	const resetsAt = unixSeconds(individual?.reset_at);
	if (reached === undefined && limit === undefined && used === undefined && remainingPercent === undefined && resetsAt === undefined) return undefined;
	return {
		...(reached === undefined ? {} : { reached }),
		...(limit === undefined ? {} : { limit }),
		...(used === undefined ? {} : { used }),
		...(remainingPercent === undefined ? {} : { remainingPercent }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function reachedType(value: unknown): string | undefined {
	const source = record(value);
	return text(source?.type) ?? text(source?.kind);
}

function normalizeBucket(
	id: string,
	name: string | undefined,
	rateLimitValue: unknown,
	creditsValue?: unknown,
	spendControlValue?: unknown,
	reachedTypeValue?: unknown,
): UsageBucket {
	const rateLimit = record(rateLimitValue);
	const windows = [
		normalizeWindow(rateLimit?.primary_window, "Primary"),
		normalizeWindow(rateLimit?.secondary_window, "Secondary"),
	].filter((window): window is UsageWindow => window !== undefined);
	const allowed = boolean(rateLimit?.allowed);
	const limitReached = boolean(rateLimit?.limit_reached);
	const credits = normalizeCredits(creditsValue);
	const spendControl = normalizeSpendControl(spendControlValue);
	const reached = reachedType(reachedTypeValue);
	return {
		id,
		...(name === undefined ? {} : { name }),
		...(allowed === undefined ? {} : { allowed }),
		...(limitReached === undefined ? {} : { limitReached }),
		windows,
		...(credits === undefined ? {} : { credits }),
		...(spendControl === undefined ? {} : { spendControl }),
		...(reached === undefined ? {} : { reachedType: reached }),
	};
}

export function normalizeUsagePayload(value: unknown, fetchedAt = Date.now()): SubscriptionUsage | undefined {
	const source = record(value);
	if (!source) return undefined;
	const planType = text(source.plan_type);
	const rateLimit = record(source.rate_limit);
	const credits = record(source.credits);
	const spendControl = record(source.spend_control);
	const additional = Array.isArray(source.additional_rate_limits) ? source.additional_rate_limits : [];
	const additionalBuckets: UsageBucket[] = [];
	for (const value of additional) {
		const item = record(value);
		if (!item) continue;
		const id = text(item.metered_feature) ?? text(item.limit_name);
		if (!id) continue;
		additionalBuckets.push(normalizeBucket(id, text(item.limit_name), item.rate_limit));
	}
	const baseRecognized = planType !== undefined || rateLimit !== undefined || credits !== undefined || spendControl !== undefined || record(source.rate_limit_reached_type) !== undefined;
	if (!baseRecognized && additionalBuckets.length === 0) return undefined;
	const buckets = baseRecognized
		? [normalizeBucket("codex", undefined, rateLimit, credits, spendControl, source.rate_limit_reached_type), ...additionalBuckets]
		: additionalBuckets;
	return {
		...(planType === undefined ? {} : { planType }),
		fetchedAt,
		buckets,
	};
}

function relativeReset(seconds: number, nowMs: number): string {
	const delta = seconds * 1000 - nowMs;
	const absoluteSeconds = Math.abs(delta) / 1000;
	const [amount, unit] = absoluteSeconds < 60
		? [Math.max(1, Math.ceil(absoluteSeconds)), "s"]
		: absoluteSeconds < 3600
			? [Math.max(1, Math.ceil(absoluteSeconds / 60)), "m"]
			: absoluteSeconds < 86400
				? [Math.max(1, Math.ceil(absoluteSeconds / 3600)), "h"]
				: [Math.max(1, Math.ceil(absoluteSeconds / 86400)), "d"];
	return delta >= 0 ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

export function formatResetTime(
	seconds: number | undefined,
	nowMs = Date.now(),
	locale?: string,
	timeZone?: string,
): string {
	const timestamp = unixSeconds(seconds);
	if (timestamp === undefined) return "unknown";
	const absolute = new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		...(timeZone === undefined ? {} : { timeZone }),
	}).format(new Date(timestamp * 1000));
	return `${relativeReset(timestamp, nowMs)} · ${absolute}`;
}

export function formatProgressBar(usedPercent: number | undefined, width = 16): string | undefined {
	if (usedPercent === undefined || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || width < 1) return undefined;
	const rounded = Math.round((usedPercent / 100) * width);
	const filled = usedPercent > 0 ? Math.max(1, rounded) : 0;
	return `${"█".repeat(filled)}${"─".repeat(width - filled)}`;
}

function formatDuration(minutes: number | undefined): string | undefined {
	if (minutes === undefined) return undefined;
	if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
	if (minutes % 60 === 0) return `${minutes / 60}-hour`;
	return `${minutes}-minute`;
}

function displayPlan(planType: string | undefined): string {
	if (!planType) return "Unknown";
	return planType.charAt(0).toUpperCase() + planType.slice(1).replaceAll("_", " ");
}

function displayBucketName(value: string): string {
	return value
		.replace(/-Codex-/gi, " Codex ")
		.replaceAll("_", " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (character) => character.toUpperCase());
}

function bucketTitle(bucket: UsageBucket): string {
	return displayBucketName(bucket.name ?? (bucket.id === "codex" ? "Codex" : bucket.id));
}

function creditsText(credits: UsageCredits): string {
	if (credits.unlimited) return "Unlimited";
	if (credits.balance !== undefined) return credits.balance;
	if (credits.hasCredits === true) return "Available";
	if (credits.hasCredits === false) return "None available";
	return "Unknown";
}

function spendControlText(spend: SpendControl, nowMs: number, locale?: string, timeZone?: string): string | undefined {
	const amount = spend.used !== undefined && spend.limit !== undefined
		? `${spend.used} of ${spend.limit} used`
		: spend.used !== undefined
			? `${spend.used} used`
			: spend.limit !== undefined
				? `Limit ${spend.limit}`
				: undefined;
	const remaining = spend.remainingPercent === undefined ? undefined : `${spend.remainingPercent}% remaining`;
	const state = spend.reached ? "Limit reached" : undefined;
	const reset = spend.resetsAt === undefined ? undefined : `resets ${formatResetTime(spend.resetsAt, nowMs, locale, timeZone)}`;
	const parts = [amount, remaining, state, reset].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function limitStatus(bucket: UsageBucket): string | undefined {
	const parts = [
		bucket.limitReached ? "Limit reached" : undefined,
		bucket.allowed === false ? "requests blocked" : undefined,
		bucket.reachedType ? bucket.reachedType.replaceAll("_", " ") : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? `  ⚠ ${parts.join(" · ")}` : undefined;
}

export function formatUsageText(
	usage: SubscriptionUsage,
	nowMs = Date.now(),
	locale?: string,
	timeZone?: string,
): string {
	const lines = [
		`◆ Codex subscription quota · ${displayPlan(usage.planType)} plan`,
		"Not OpenAI API billing or general ChatGPT limits.",
		"",
	];
	for (const [index, bucket] of usage.buckets.entries()) {
		if (index > 0) lines.push("");
		lines.push(`◇ ${bucketTitle(bucket)}`);
		if (bucket.windows.length === 0) lines.push("  Usage windows unknown");
		for (const window of bucket.windows) {
			const bar = formatProgressBar(window.usedPercent);
			if (bar && window.usedPercent !== undefined) {
				const remaining = window.remainingPercent === undefined ? "remaining unknown" : `${window.remainingPercent}% remaining`;
				lines.push(`  ${window.name}  ${bar}  ${window.usedPercent}% used · ${remaining}`);
			} else {
				lines.push(`  ${window.name}`);
			}
			const duration = formatDuration(window.durationMinutes);
			const reset = window.resetsAt === undefined ? undefined : formatResetTime(window.resetsAt, nowMs, locale, timeZone);
			if (duration || reset) {
				lines.push(`           ${duration ? `${duration} window` : "window unknown"} · ${reset ? `resets ${reset}` : "reset unknown"}`);
			} else {
				lines.push("           Usage unknown · window and reset unknown");
			}
		}
		const status = limitStatus(bucket);
		if (status) lines.push(status);
		if (bucket.credits) lines.push(`  Credits  ${creditsText(bucket.credits)}`);
		if (bucket.spendControl) {
			const spend = spendControlText(bucket.spendControl, nowMs, locale, timeZone);
			if (spend) lines.push(`  Spend control  ${spend}`);
		}
	}
	return lines.join("\n");
}

export type UsageTextStyles = {
	title(value: string): string;
	section(value: string): string;
	muted(value: string): string;
	success(value: string): string;
	warning(value: string): string;
	error(value: string): string;
};

export function styleUsageText(content: string, styles: UsageTextStyles): string {
	return content.split("\n").map((line, index) => {
		if (index === 0) return styles.title(line);
		if (index === 1 || line.startsWith("           ")) return styles.muted(line);
		if (line.startsWith("◇ ")) return styles.section(line);
		if (line.startsWith("  ⚠ ")) return styles.error(line);
		const match = line.match(/([█─]+).*?([0-9]+(?:\.[0-9]+)?)% used/);
		if (!match) return line;
		const percent = Number(match[2]);
		const color = percent >= 85 ? styles.error : percent >= 60 ? styles.warning : styles.success;
		return line.replace(match[1], color(match[1]));
	}).join("\n");
}

export function safeUsageError(error: unknown): string {
	const code = text(record(error)?.code) as UsageErrorCode | undefined;
	if (code === "not-authenticated") return "Sign in to ChatGPT Plus/Pro with pi /login to view Codex subscription usage.";
	if (code === "unauthorized") return "The Codex subscription session could not be authorized. Run pi /login and try again.";
	if (code === "timeout") return "Codex subscription usage timed out. Try again or open the official dashboard.";
	return "Codex subscription usage is unavailable. Open the official dashboard or try again.";
}
