export type Money = {
	amountMinor: number;
	currency: string;
	exponent: number;
};

export type UsageWindow = {
	id: string;
	label: string;
	usedPercent?: number;
	remainingPercent?: number;
	resetsAt?: number;
	severity?: string;
	active?: boolean;
	limit?: Money;
	used?: Money;
	remaining?: Money;
};

export type SpendState = {
	enabled?: boolean;
	used?: Money;
	limit?: Money;
	cap?: Money;
	balance?: Money;
	usedPercent?: number;
	limitReached?: boolean;
	userDisabled?: boolean;
	disabledReason?: string;
	severity?: string;
	disclaimer?: string;
};

export type AccountInfo = {
	email?: string;
	organization?: string;
	organizationType?: string;
	plan?: string;
	seat?: string;
	extraUsageEnabled?: boolean;
};

export type ClaudeUsage = {
	fetchedAt: number;
	windows: UsageWindow[];
	spend?: SpendState;
	account?: AccountInfo;
};

type UsageErrorCode = "not-authenticated" | "unauthorized" | "timeout" | "invalid-response" | "backend";

const ANTHROPIC_PROVIDER = "anthropic";

const WINDOW_LABELS: Record<string, string> = {
	five_hour: "5-hour session",
	seven_day: "7-day all models",
	seven_day_opus: "7-day Opus",
	seven_day_sonnet: "7-day Sonnet",
	seven_day_cowork: "7-day Cowork",
	seven_day_oauth_apps: "7-day OAuth apps",
	seven_day_omelette: "7-day Omelette",
};

const LIMIT_KIND_WINDOWS: Record<string, string> = {
	session: "five_hour",
	weekly_all: "seven_day",
};

const DETAIL_PREFIX = "      ";

type AnthropicOAuthRegistry = {
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

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentage(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number >= 0 ? Math.min(100, number) : undefined;
}

function timestamp(value: unknown): number | undefined {
	const iso = text(value);
	if (iso === undefined) return undefined;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export async function resolveAnthropicOAuthToken(registry: AnthropicOAuthRegistry): Promise<string | undefined> {
	const model = registry.getAll().find((candidate) => candidate.provider === ANTHROPIC_PROVIDER);
	if (!model || !registry.isUsingOAuth(model)) return undefined;
	return await registry.getApiKeyForProvider(ANTHROPIC_PROVIDER);
}

function money(amountMinor: unknown, currency: string | undefined, exponent: number): Money | undefined {
	const minor = finite(amountMinor);
	if (minor === undefined) return undefined;
	return { amountMinor: Math.round(minor), currency: currency ?? "USD", exponent };
}

function moneyFromRecord(value: unknown): Money | undefined {
	const source = record(value);
	if (!source) return undefined;
	return money(source.amount_minor, text(source.currency), finite(source.exponent) ?? 2);
}

function moneyFromMajor(value: unknown, currency: string | undefined): Money | undefined {
	const major = finite(value);
	if (major === undefined) return undefined;
	return { amountMinor: Math.round(major * 100), currency: currency ?? "USD", exponent: 2 };
}

type LimitEntry = {
	kind?: string;
	group?: string;
	usedPercent?: number;
	severity?: string;
	resetsAt?: number;
	scopeLabel?: string;
	active?: boolean;
};

function scopeLabel(value: unknown): string | undefined {
	const scope = record(value);
	if (!scope) return undefined;
	const model = text(record(scope.model)?.display_name) ?? text(record(scope.model)?.id);
	const surface = text(scope.surface);
	return model ?? surface;
}

function normalizeLimitEntries(value: unknown): LimitEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: LimitEntry[] = [];
	for (const item of value) {
		const source = record(item);
		if (!source) continue;
		entries.push(defined<LimitEntry>({
			kind: text(source.kind),
			group: text(source.group),
			usedPercent: percentage(source.percent),
			severity: text(source.severity),
			resetsAt: timestamp(source.resets_at),
			scopeLabel: scopeLabel(source.scope),
			active: boolean(source.is_active),
		}));
	}
	return entries;
}

function payloadCurrency(source: Record<string, unknown>): string | undefined {
	return text(record(record(source.spend)?.used)?.currency)
		?? text(record(record(source.spend)?.limit)?.currency)
		?? text(record(source.extra_usage)?.currency);
}

function normalizeWindow(id: string, value: unknown, entry: LimitEntry | undefined, currency: string | undefined): UsageWindow | undefined {
	const source = record(value);
	if (!source && !entry) return undefined;
	const usedPercent = percentage(source?.utilization) ?? entry?.usedPercent;
	return {
		id,
		label: WINDOW_LABELS[id] ?? id,
		...defined<Omit<UsageWindow, "id" | "label">>({
			usedPercent,
			remainingPercent: usedPercent === undefined ? undefined : 100 - usedPercent,
			resetsAt: timestamp(source?.resets_at) ?? entry?.resetsAt,
			severity: entry?.severity,
			active: entry?.active,
			limit: moneyFromMajor(source?.limit_dollars, currency),
			used: moneyFromMajor(source?.used_dollars, currency),
			remaining: moneyFromMajor(source?.remaining_dollars, currency),
		}),
	};
}

function defined<T extends Record<string, unknown>>(entries: T): Partial<T> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entries)) {
		if (value !== undefined) result[key] = value;
	}
	return result as Partial<T>;
}

function normalizeSpend(source: Record<string, unknown>, currency: string | undefined): SpendState | undefined {
	const spend = record(source.spend);
	const extra = record(source.extra_usage);
	if (!spend && !extra) return undefined;
	const decimals = finite(extra?.decimal_places) ?? 2;
	const state = defined<SpendState>({
		enabled: boolean(spend?.enabled) ?? boolean(extra?.is_enabled),
		used: moneyFromRecord(spend?.used) ?? money(extra?.used_credits, currency, decimals),
		limit: moneyFromRecord(spend?.limit) ?? money(extra?.monthly_limit, currency, decimals),
		cap: moneyFromRecord(record(spend?.cap)?.money),
		balance: moneyFromRecord(spend?.balance),
		usedPercent: percentage(spend?.percent) ?? percentage(extra?.utilization),
		limitReached: boolean(extra?.spend_limit_reached),
		userDisabled: boolean(extra?.user_disabled),
		disabledReason: text(spend?.disabled_reason) ?? text(extra?.disabled_reason),
		severity: text(spend?.severity),
		disclaimer: text(spend?.disclaimer),
	});
	return Object.keys(state).length > 0 ? state : undefined;
}

export function normalizeUsagePayload(value: unknown, fetchedAt = Date.now()): Omit<ClaudeUsage, "account"> | undefined {
	const source = record(value);
	if (!source) return undefined;
	const currency = payloadCurrency(source);
	const entries = normalizeLimitEntries(source.limits);
	const windows: UsageWindow[] = [];
	for (const id of Object.keys(WINDOW_LABELS)) {
		const entry = entries.find((candidate) => candidate.kind !== undefined && LIMIT_KIND_WINDOWS[candidate.kind] === id);
		const window = record(source[id]) === undefined && entry === undefined ? undefined : normalizeWindow(id, source[id], entry, currency);
		if (window) windows.push(window);
	}
	for (const entry of entries) {
		if (entry.scopeLabel === undefined) continue;
		windows.push({
			id: `${entry.kind ?? "scoped"}:${entry.scopeLabel}`,
			label: `${entry.group === "weekly" ? "7-day" : entry.group === "session" ? "5-hour" : entry.kind ?? "Scoped"} ${entry.scopeLabel}`,
			...defined<Omit<UsageWindow, "id" | "label">>({
				usedPercent: entry.usedPercent,
				remainingPercent: entry.usedPercent === undefined ? undefined : 100 - entry.usedPercent,
				resetsAt: entry.resetsAt,
				severity: entry.severity,
				active: entry.active,
			}),
		});
	}
	const spend = normalizeSpend(source, currency);
	if (windows.length === 0 && spend === undefined) return undefined;
	return { fetchedAt, windows, ...(spend === undefined ? {} : { spend }) };
}

function displayTier(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.replace(/^default[_-]/, "")
		.replaceAll("_", " ")
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function normalizeProfilePayload(value: unknown): AccountInfo | undefined {
	const source = record(value);
	if (!source) return undefined;
	const account = record(source.account);
	const organization = record(source.organization);
	const plan = displayTier(text(organization?.rate_limit_tier))
		?? (boolean(account?.has_claude_max) ? "Claude Max" : boolean(account?.has_claude_pro) ? "Claude Pro" : undefined);
	const info = defined<AccountInfo>({
		email: text(account?.email),
		organization: text(organization?.name),
		organizationType: displayTier(text(organization?.organization_type)),
		plan,
		seat: displayTier(text(organization?.seat_tier)),
		extraUsageEnabled: boolean(organization?.has_extra_usage_enabled),
	});
	return Object.keys(info).length > 0 ? info : undefined;
}

function relativeReset(target: number, nowMs: number): string {
	const delta = target - nowMs;
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

export function formatTime(target: number | undefined, locale?: string, timeZone?: string): string {
	if (target === undefined || !Number.isFinite(target)) return "unknown";
	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		...(timeZone === undefined ? {} : { timeZone }),
	}).format(new Date(target));
}

export function formatResetTime(target: number | undefined, nowMs = Date.now(), locale?: string, timeZone?: string): string {
	if (target === undefined || !Number.isFinite(target)) return "unknown";
	return `${relativeReset(target, nowMs)} · ${formatTime(target, locale, timeZone)}`;
}

export function formatProgressBar(usedPercent: number | undefined, width = 16): string | undefined {
	if (usedPercent === undefined || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || width < 1) return undefined;
	const rounded = Math.round((usedPercent / 100) * width);
	const filled = usedPercent > 0 ? Math.max(1, rounded) : 0;
	return `${"█".repeat(filled)}${"─".repeat(width - filled)}`;
}

export function formatMoney(value: Money | undefined, locale?: string): string | undefined {
	if (!value) return undefined;
	const amount = value.amountMinor / 10 ** value.exponent;
	try {
		return new Intl.NumberFormat(locale, { style: "currency", currency: value.currency }).format(amount);
	} catch {
		return `${amount.toFixed(value.exponent)} ${value.currency}`;
	}
}

function headerLine(account: AccountInfo | undefined): string {
	const parts = [account?.plan, account?.organization, account?.seat].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? `◆ Claude subscription usage · ${parts.join(" · ")}` : "◆ Claude subscription usage";
}

function windowMoneyText(window: UsageWindow, locale?: string): string | undefined {
	const used = formatMoney(window.used, locale);
	const limit = formatMoney(window.limit, locale);
	const remaining = formatMoney(window.remaining, locale);
	if (used && limit) return `${used} of ${limit}${remaining ? ` · ${remaining} left` : ""}`;
	return used ?? limit ?? remaining;
}

function spendLines(spend: SpendState, locale?: string): string[] {
	const used = formatMoney(spend.used, locale);
	const limit = formatMoney(spend.limit, locale);
	const amount = used && limit ? `${used} of ${limit} used` : used ? `${used} used` : limit ? `Limit ${limit}` : undefined;
	const percent = spend.usedPercent === undefined ? undefined : `${spend.usedPercent}%`;
	const state = spend.limitReached
		? "spend limit reached"
		: spend.userDisabled
			? "disabled by you"
			: spend.enabled === false
				? "disabled"
				: spend.enabled === true
					? "enabled"
					: undefined;
	const summary = [amount, percent, state].filter((part): part is string => part !== undefined).join(" · ");
	const bar = formatProgressBar(spend.usedPercent);
	const lines = [summary.length > 0 ? `  ${bar ? `${bar}  ` : ""}${summary}` : "  Extra usage state unknown"];
	const cap = formatMoney(spend.cap, locale);
	const balance = formatMoney(spend.balance, locale);
	const extra = [
		cap === undefined ? undefined : `monthly cap ${cap}`,
		balance === undefined ? undefined : `balance ${balance}`,
		spend.disabledReason === undefined ? undefined : `reason ${spend.disabledReason.replaceAll("_", " ")}`,
		spend.enabled !== false && spend.limit?.amountMinor === 0 ? "no monthly limit configured for this member" : undefined,
	].filter((part): part is string => part !== undefined);
	if (extra.length > 0) lines.push(`${DETAIL_PREFIX}${extra.join(" · ")}`);
	if (spend.limitReached || spend.severity === "critical") lines.push("  ⚠ Extra usage spend limit reached · requests fall back to plan limits");
	return lines;
}

export function formatUsageText(usage: ClaudeUsage, nowMs = Date.now(), locale?: string, timeZone?: string): string {
	const lines = [
		headerLine(usage.account),
		"Included plan quota shared across Claude apps; not Anthropic API billing.",
		"",
		"◇ Rate limits",
	];
	if (usage.windows.length === 0) lines.push("  Usage windows unknown");
	const labelWidth = Math.max(0, ...usage.windows.map((window) => window.label.length));
	for (const window of usage.windows) {
		const bar = formatProgressBar(window.usedPercent);
		const label = window.label.padEnd(labelWidth);
		if (bar && window.usedPercent !== undefined) {
			const remaining = window.remainingPercent === undefined ? "remaining unknown" : `${window.remainingPercent}% remaining`;
			lines.push(`  ${label}  ${bar}  ${window.usedPercent}% used · ${remaining}`);
		} else {
			lines.push(`  ${label}  usage unknown`);
		}
		const details = [
			window.resetsAt === undefined ? "reset unknown" : `resets ${formatResetTime(window.resetsAt, nowMs, locale, timeZone)}`,
			window.active === true ? "active window" : undefined,
			window.severity !== undefined && window.severity !== "normal" ? `severity ${window.severity}` : undefined,
			windowMoneyText(window, locale),
		].filter((part): part is string => part !== undefined);
		lines.push(`${DETAIL_PREFIX}${details.join(" · ")}`);
	}
	lines.push("", "◇ Extra usage (over-plan spend)");
	if (usage.spend) lines.push(...spendLines(usage.spend, locale));
	else lines.push("  Not reported for this account");
	if (usage.account?.extraUsageEnabled === false) lines.push(`${DETAIL_PREFIX}organization has extra usage disabled`);
	lines.push("", `Fetched ${formatTime(usage.fetchedAt, locale, timeZone)}`);
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
		if (index === 1 || line.startsWith(DETAIL_PREFIX) || line.startsWith("Fetched ")) return styles.muted(line);
		if (line.startsWith("◇ ")) return styles.section(line);
		if (line.startsWith("  ⚠ ")) return styles.error(line);
		const match = line.match(/([█─]+)/);
		const percentMatch = line.match(/([0-9]+(?:\.[0-9]+)?)%/);
		if (!match || !percentMatch) return line;
		const percent = Number(percentMatch[1]);
		const color = percent >= 85 ? styles.error : percent >= 60 ? styles.warning : styles.success;
		return line.replace(match[1], color(match[1]));
	}).join("\n");
}

export function safeUsageError(error: unknown): string {
	const code = text(record(error)?.code) as UsageErrorCode | undefined;
	if (code === "not-authenticated") return "Sign in to a Claude subscription with pi /login to view Claude usage.";
	if (code === "unauthorized") return "The Claude subscription session could not be authorized. Run pi /login and try again.";
	if (code === "timeout") return "Claude usage lookup timed out. Try again or open the official dashboard.";
	return "Claude usage is unavailable. Open the official dashboard or try again.";
}
