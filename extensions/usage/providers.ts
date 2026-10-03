import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as anthropic from "./anthropic.ts";
import * as openai from "./openai.ts";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_DASHBOARD_URL = "https://claude.ai/settings/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.206";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage";
const CHATGPT_DASHBOARD_URL = "https://chatgpt.com/settings/usage";
const REQUEST_TIMEOUT_MS = 10_000;

export type UsageProviderId = "anthropic" | "openai" | "openai-codex";
export type UsageErrorCode = "not-authenticated" | "unauthorized" | "timeout" | "invalid-response" | "backend";

export type UsageStyles = {
	title(value: string): string;
	section(value: string): string;
	muted(value: string): string;
	success(value: string): string;
	warning(value: string): string;
	error(value: string): string;
};

export type UsageProvider = {
	id: UsageProviderId;
	label: string;
	dashboardUrl: string;
	available(ctx: ExtensionCommandContext): Promise<boolean>;
	snapshot(ctx: ExtensionCommandContext): Promise<string>;
	unavailableText(error: unknown, cachedText?: string): string;
	style(content: string, styles: UsageStyles): string;
};

export type Scope =
	| { kind: "provider"; providers: [UsageProvider] }
	| { kind: "all"; providers: UsageProvider[] };

function usageFailure(code: UsageErrorCode): { code: UsageErrorCode } {
	return { code };
}

export function errorCode(error: unknown): UsageErrorCode | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return code === "not-authenticated" || code === "unauthorized" || code === "timeout" || code === "invalid-response" || code === "backend"
		? code
		: undefined;
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers }, signal: controller.signal });
		if (response.status === 401 || response.status === 403) throw usageFailure("unauthorized");
		if (!response.ok) throw usageFailure("backend");
		try {
			return await response.json();
		} catch {
			throw usageFailure(controller.signal.aborted ? "timeout" : "invalid-response");
		}
	} catch (error) {
		if (errorCode(error)) throw error;
		throw usageFailure(controller.signal.aborted ? "timeout" : "backend");
	} finally {
		clearTimeout(timeout);
	}
}

function unavailableLines(title: string, disclaimer: string, message: string, cachedText?: string): string {
	const lines = [title, disclaimer, "", message];
	if (cachedText) lines.push("", "Last successful in-memory snapshot:", cachedText);
	return lines.join("\n");
}

const anthropicProvider: UsageProvider = {
	id: "anthropic",
	label: "Claude",
	dashboardUrl: ANTHROPIC_DASHBOARD_URL,
	available: async (ctx) => await anthropic.resolveAnthropicOAuthToken(ctx.modelRegistry) !== undefined,
	snapshot: async (ctx) => {
		const accessToken = await anthropic.resolveAnthropicOAuthToken(ctx.modelRegistry);
		if (!accessToken) throw usageFailure("not-authenticated");
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			"user-agent": CLAUDE_CODE_USER_AGENT,
			"x-app": "cli",
		};
		const usage = anthropic.normalizeUsagePayload(await requestJson(ANTHROPIC_USAGE_URL, headers));
		if (!usage) throw usageFailure("invalid-response");
		const account = await requestJson(ANTHROPIC_PROFILE_URL, headers).then(anthropic.normalizeProfilePayload).catch(() => undefined);
		return anthropic.formatUsageText({ ...usage, ...(account === undefined ? {} : { account }) });
	},
	unavailableText: (error, cachedText) =>
		unavailableLines(
			"◆ Claude subscription usage",
			"Included plan quota shared across Claude apps; not Anthropic API billing.",
			anthropic.safeUsageError(error),
			cachedText,
		),
	style: (content, styles) => anthropic.styleUsageText(content, styles),
};

const codexProvider: UsageProvider = {
	id: "openai-codex",
	label: "Codex",
	dashboardUrl: CODEX_DASHBOARD_URL,
	available: async (ctx) => await openai.resolveCodexOAuthAuth(ctx.modelRegistry) !== undefined,
	snapshot: async (ctx) => {
		const auth = await openai.resolveCodexOAuthAuth(ctx.modelRegistry);
		if (!auth) throw usageFailure("not-authenticated");
		const payload = await requestJson(CODEX_USAGE_URL, {
			Authorization: `Bearer ${auth.accessToken}`,
			"ChatGPT-Account-Id": auth.accountId,
		});
		const usage = openai.normalizeUsagePayload(payload);
		if (!usage) throw usageFailure("invalid-response");
		return openai.formatUsageText(usage);
	},
	unavailableText: (error, cachedText) =>
		unavailableLines(
			"◆ Codex subscription quota",
			"Included Codex quota; not OpenAI API billing or general ChatGPT limits.",
			openai.safeUsageError(error),
			cachedText,
		),
	style: (content, styles) => openai.styleUsageText(content, styles),
};

const chatGPTProvider: UsageProvider = {
	id: "openai",
	label: "ChatGPT",
	dashboardUrl: CHATGPT_DASHBOARD_URL,
	available: async (ctx) => await openai.hasChatGPTOAuth(ctx.modelRegistry),
	snapshot: async (ctx) => {
		if (!await openai.hasChatGPTOAuth(ctx.modelRegistry)) throw usageFailure("not-authenticated");
		throw usageFailure("backend");
	},
	unavailableText: (error) => unavailableLines(
		"◆ ChatGPT subscription usage",
		"Shared ChatGPT subscription usage; not OpenAI API billing or Codex quota.",
		errorCode(error) === "not-authenticated"
			? "Sign in with ChatGPT using pi /login openai to view subscription usage."
			: `Live quota is unavailable for this login. Open the official dashboard: ${CHATGPT_DASHBOARD_URL}`,
	),
	style: (content, styles) => openai.styleUsageText(content, styles),
};

export const USAGE_PROVIDERS: readonly UsageProvider[] = [anthropicProvider, codexProvider, chatGPTProvider];

export function providerFor(providerId: string | undefined): UsageProvider | undefined {
	return USAGE_PROVIDERS.find((provider) => provider.id === providerId);
}

export function resolveScope(currentProviderId: string | undefined, available: readonly UsageProviderId[]): Scope {
	const current = providerFor(currentProviderId);
	if (current && (current.id !== "openai" || available.includes(current.id))) return { kind: "provider", providers: [current] };
	return { kind: "all", providers: USAGE_PROVIDERS.filter((provider) => available.includes(provider.id)) };
}

export async function availableProviderIds(ctx: ExtensionCommandContext): Promise<UsageProviderId[]> {
	const flags = await Promise.all(USAGE_PROVIDERS.map(async (provider) => await provider.available(ctx).catch(() => false)));
	return USAGE_PROVIDERS.filter((_, index) => flags[index]).map((provider) => provider.id);
}

export type UsageMenuItem = { value: string; label: string; description?: string };

export function usageMenu(scope: Scope, currentProviderId: string | undefined, available: readonly UsageProviderId[]): UsageMenuItem[] {
	const shown = scope.providers;
	const items: UsageMenuItem[] = [{ value: "refresh", label: "Refresh", description: "Fetch a new usage snapshot" }];
	for (const provider of shown) {
		items.push({
			value: `dashboard:${provider.id}`,
			label: `Open ${provider.label} dashboard`,
			description: provider.dashboardUrl,
		});
	}
	const others = USAGE_PROVIDERS.filter((provider) => available.includes(provider.id) && !shown.includes(provider));
	if (scope.kind === "provider" && others.length > 0) {
		items.push({
			value: "all",
			label: "Show all providers",
			description: `Also show ${others.map((provider) => provider.label).join(" and ")} usage`,
		});
	}
	const current = providerFor(currentProviderId);
	if (scope.kind === "all" && current && (current.id !== "openai" || available.includes(current.id))) {
		items.push({ value: `only:${current.id}`, label: `Show ${current.label} only`, description: "Current model's provider" });
	}
	items.push({ value: "close", label: "Close" });
	return items;
}

export function noProvidersText(): string {
	return [
		"◆ Subscription usage",
		"No Claude, ChatGPT, or Codex subscription login found.",
		"",
		"Run pi /login for anthropic, openai, or openai-codex to see subscription usage here.",
	].join("\n");
}
