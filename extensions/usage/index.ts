import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { showUsageModal } from "./modal.ts";
import {
	availableProviderIds,
	errorCode,
	noProvidersText,
	providerFor,
	resolveScope,
	type Scope,
	USAGE_PROVIDERS,
	type UsageProvider,
	type UsageProviderId,
	type UsageStyles,
	usageMenu,
} from "./providers.ts";

type Segment = { provider: UsageProvider; text: string; live: boolean };

async function loadSegments(
	ctx: ExtensionCommandContext,
	scope: Scope,
	cache: Map<UsageProviderId, string>,
): Promise<Segment[]> {
	return await Promise.all(scope.providers.map(async (provider) => {
		try {
			const text = await provider.snapshot(ctx);
			cache.set(provider.id, text);
			return { provider, text, live: true };
		} catch (error) {
			const code = errorCode(error);
			if (code === "not-authenticated" || code === "unauthorized") cache.delete(provider.id);
			return { provider, text: provider.unavailableText(error, cache.get(provider.id)), live: false };
		}
	}));
}

function renderSegments(segments: Segment[], styles: UsageStyles): string {
	if (segments.length === 0) return styles.muted(noProvidersText());
	return segments.map((segment) => segment.provider.style(segment.text, styles)).join(`\n${styles.muted("─".repeat(24))}\n`);
}

function plainText(segments: Segment[]): string {
	return segments.length === 0 ? noProvidersText() : segments.map((segment) => segment.text).join("\n\n");
}

async function openDashboard(pi: ExtensionAPI, url: string): Promise<boolean> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const result = await pi.exec(command, args, { timeout: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

export default function usageExtension(pi: ExtensionAPI) {
	const cache = new Map<UsageProviderId, string>();

	pi.registerCommand("usage", {
		description: "Show subscription usage for the current model's provider",
		handler: async (_args, ctx) => {
			const currentProviderId = ctx.model?.provider;
			let available = await availableProviderIds(ctx);
			let scope = resolveScope(currentProviderId, available);
			let explicitScope = false;
			let segments = await loadSegments(ctx, scope, cache);

			if (ctx.mode !== "tui") {
				const text = plainText(segments);
				ctx.ui.notify(text, segments.some((segment) => segment.live) ? "info" : "warning");
				return;
			}

			while (true) {
				const items = usageMenu(scope, currentProviderId, available) as SelectItem[];
				const action = await showUsageModal(ctx, items, (styles) => renderSegments(segments, styles));
				if (action === "close") return;
				if (action.startsWith("dashboard:")) {
					const provider = providerFor(action.slice("dashboard:".length));
					if (!provider) continue;
					const opened = await openDashboard(pi, provider.dashboardUrl);
					ctx.ui.notify(
						opened ? `Opened the official ${provider.label} usage dashboard.` : `Open ${provider.dashboardUrl} in your browser.`,
						opened ? "info" : "warning",
					);
					continue;
				}
				if (action === "all") {
					explicitScope = true;
					scope = { kind: "all", providers: USAGE_PROVIDERS.filter((provider) => available.includes(provider.id) || scope.providers.includes(provider)) };
				}
				else if (action.startsWith("only:")) {
					const provider = providerFor(action.slice("only:".length));
					if (provider) {
						explicitScope = true;
						scope = { kind: "provider", providers: [provider] };
					}
				} else {
					available = await availableProviderIds(ctx);
					if (!explicitScope) scope = resolveScope(currentProviderId, available);
					else if (scope.kind === "all") scope = { kind: "all", providers: USAGE_PROVIDERS.filter((provider) => available.includes(provider.id)) };
				}
				segments = await loadSegments(ctx, scope, cache);
			}
		},
	});
}
