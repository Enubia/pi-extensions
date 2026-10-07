import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
type FooterData = {
	getExtensionStatuses?: () => ReadonlyMap<string, string>;
};
type FooterTheme = {
	fg(color: string, text: string): string;
};
type FooterTui = { requestRender?: () => void };
type SessionEntry = {
	type?: string;
	id?: string;
	message?: { role?: string; provider?: string; model?: string; api?: string; thinkingLevel?: string; stopReason?: string };
};
type SessionContext = {
	cwd?: string;
	model?: { id?: string; provider?: string; api?: string; contextWindow?: number };
	thinkingLevel?: string;
	getContextUsage?: () => Usage;
	sessionManager?: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
		getBranch?: () => SessionEntry[];
		getEntries?: () => SessionEntry[];
	};
	ui: { setFooter: (footer: unknown) => void; notify: (message: string, level: string) => void };
};
type StatuslineState = {
	getModel?: () => SessionContext["model"];
	getThinking?: () => string;
	getBranch?: () => SessionEntry[];
	getUsage?: () => Usage;
	getMemorySnapshot?: () => { snapshot: MemorySnapshot; module: OmSnapshotModule } | undefined;
	requestRender?: () => void;
};
type MemoryProgress = { label: string; current: number; total: number };
type MemorySnapshot = { enabled: boolean; bars: MemoryProgress[] };
type OmSnapshotModule = {
	memorySnapshot: (ctx: SessionContext) => MemorySnapshot;
	OM_PAUSE_STATUS_KEY: string;
	parsePauseStatus: (status: string | undefined) => Set<string>;
};
type MemoryView = { snapshot: MemorySnapshot; paused: Set<string> };

const BASH_GUARD_STATUS_KEY = " bash-guard";
const MEMORY_BAR_WIDTH = 8;
const MEMORY_BAR_FRACTIONS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

let omSnapshotModule: OmSnapshotModule | null | undefined;
let omSnapshotPending: Promise<void> | undefined;
let cachedMemorySnapshot: { key: string; snapshot: MemorySnapshot } | undefined;

function loadOmSnapshot(onReady: () => void): OmSnapshotModule | undefined {
	if (omSnapshotModule !== undefined) return omSnapshotModule ?? undefined;
	if (!omSnapshotPending) {
		omSnapshotPending = import("./observational-memory/src/status/snapshot.ts")
			.then((module) => {
				omSnapshotModule = module as OmSnapshotModule;
				onReady();
			})
			.catch(() => {
				omSnapshotModule = null;
			});
	}
	return undefined;
}

function memorySnapshot(ctx: SessionContext, module: OmSnapshotModule): MemorySnapshot {
	const entries = ctx.sessionManager?.getBranch?.() ?? [];
	const last = entries[entries.length - 1];
	const usage = ctx.getContextUsage?.();
	const tokens = usage?.tokens ?? "";
	const key = `${ctx.cwd ?? ""}:${entries.length}:${last?.id ?? ""}:${tokens}:${usage?.contextWindow ?? ""}:${ctx.model?.contextWindow ?? ""}:${ctx.model?.provider ?? ""}:${ctx.model?.id ?? ""}:${ctx.sessionManager?.getSessionId?.() ?? ""}`;
	if (cachedMemorySnapshot?.key === key) return cachedMemorySnapshot.snapshot;
	const snapshot = module.memorySnapshot(ctx);
	cachedMemorySnapshot = { key, snapshot };
	return snapshot;
}

function formatBar(item: MemoryProgress, theme: FooterTheme, withBar: boolean, paused: boolean): string {
	const ratio = item.total > 0 ? Math.min(1, Math.max(0, item.current / item.total)) : 0;
	const percentage = Math.round(ratio * 100);
	const color = paused ? "warning" : percentage >= 80 ? "success" : percentage >= 60 ? "accent" : "dim";
	const label = paused ? theme.fg("warning", `${item.label}⏸`) : theme.fg("dim", item.label);
	const value = theme.fg(color, `${percentage}%`);
	if (!withBar) return `${label} ${value}`;
	const filledUnits = Math.round(ratio * MEMORY_BAR_WIDTH * 8);
	const fullCells = Math.floor(filledUnits / 8);
	const partialCell = MEMORY_BAR_FRACTIONS[filledUnits % 8] ?? "";
	const emptyCells = MEMORY_BAR_WIDTH - fullCells - (partialCell ? 1 : 0);
	const fill = "█".repeat(fullCells) + partialCell;
	return `${label} ${theme.fg("dim", "[")}${theme.fg(color, fill)}${theme.fg("dim", " ".repeat(emptyCells))}${theme.fg("dim", "]")} ${value}`;
}

function formatMemorySnapshot(view: MemoryView | undefined, theme: FooterTheme, budget: number): string {
	if (!view || !view.snapshot.enabled || view.snapshot.bars.length === 0) return "";
	const { snapshot, paused } = view;
	const withBars = snapshot.bars.map((item) => formatBar(item, theme, true, paused.has(item.label))).join(" ");
	if (visibleWidth(withBars) <= budget) return withBars;
	return snapshot.bars.map((item) => formatBar(item, theme, false, paused.has(item.label))).join(" ");
}

function memoryView(state: StatuslineState, footerData: FooterData): MemoryView | undefined {
	const loaded = state.getMemorySnapshot?.();
	if (!loaded) return undefined;
	const status = footerData.getExtensionStatuses?.().get(loaded.module.OM_PAUSE_STATUS_KEY);
	return { snapshot: loaded.snapshot, paused: loaded.module.parsePauseStatus(status) };
}

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 0 : 1)}M`;
}

function formatContext(value: number | undefined): string {
	if (!value) return "context";
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M context`;
	if (value >= 1000) return `${Math.round(value / 1000)}k context`;
	return `${value} context`;
}

function displayModel(model: SessionContext["model"]): string {
	if (!model?.id) return "No model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function colorTokens(tokens: number, text: string): string {
	const color = tokens >= 150_000 ? "\x1b[38;2;255;255;0m" : "\x1b[38;2;0;255;0m";
	return `${color}${text}\x1b[39m`;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width));
}

function plainText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function alignRow(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (!right) return fit(left, width);
	if (!left || width <= rightWidth) return fit(right, width);
	const leftPart = fit(left, width - rightWidth - 1);
	const spaces = Math.max(1, width - visibleWidth(leftPart) - rightWidth);
	return leftPart + " ".repeat(spaces) + right;
}

function nameRow(name: string | undefined, theme: FooterTheme, width: number): string[] {
	const trimmed = name?.trim();
	if (!trimmed) return [];
	return [alignRow("", theme.fg("dim", `\u2b1a ${trimmed}`), width)];
}

function bashGuardStatus(footerData: FooterData): string {
	return footerData.getExtensionStatuses?.().get(BASH_GUARD_STATUS_KEY) ?? "";
}

function failoverStatus(footerData: FooterData, theme: FooterTheme): string {
	const status = footerData.getExtensionStatuses?.().get("provider-failover");
	return status ? theme.fg("warning", plainText(status)) : "";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let fallbackStateId = 0;
	const fallbackStateKeys = new WeakMap<object, string>();
	const states = new Map<string, StatuslineState>();

	const stateKey = (ctx: SessionContext): string => {
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		if (sessionFile) return `file:${sessionFile}`;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) return `id:${sessionId}`;
		let key = fallbackStateKeys.get(ctx);
		if (!key) {
			key = `fallback:${++fallbackStateId}`;
			fallbackStateKeys.set(ctx, key);
		}
		return key;
	};

	const bind = (ctx: SessionContext): StatuslineState => {
		const key = stateKey(ctx);
		let state = states.get(key);
		if (!state) {
			state = {};
			states.set(key, state);
		}
		state.getModel = () => ctx.model;
		state.getThinking = () => ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off";
		state.getBranch = () => ctx.sessionManager?.getBranch?.() ?? [];
		state.getUsage = ctx.getContextUsage?.bind(ctx);
		state.getMemorySnapshot = () => {
			const module = loadOmSnapshot(() => {});
			return module ? { snapshot: memorySnapshot(ctx, module), module } : undefined;
		};
		return state;
	};

	const apply = (ctx: SessionContext) => {
		const state = bind(ctx);
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}
		ctx.ui.setFooter((tui: FooterTui, theme: FooterTheme, footerData: FooterData) => {
			state.requestRender = () => tui.requestRender?.();
			loadOmSnapshot(() => tui.requestRender?.());
			return {
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					const usage = state.getUsage?.();
					const tokens = usage?.tokens ?? null;
					const percent = usage?.percent ?? null;
					const selected = state.getModel?.();
					const contextWindow = usage?.contextWindow ?? selected?.contextWindow;
					const thinking = state.getThinking?.() ?? "off";
					const virtual = selected?.api === "pi-virtual";
					const routed = virtual ? state.getBranch?.().findLast((entry) => {
						const message = entry.message;
						return entry.type === "message" && message?.role === "assistant"
							&& message.api !== "pi-virtual" && message.provider && message.model
							&& message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "pending";
					})?.message : undefined;
					const model = `${displayModel(selected)} (${formatContext(contextWindow)})`;
					const left = theme.fg("accent", model);
					const selectedThinking = thinking !== "off" || virtual ? ` ${theme.fg("dim", `[${thinking}]`)}` : "";
					const routedPart = routed
						? ` ${theme.fg("dim", "→")} ${theme.fg("accent", `${routed.provider}/${routed.model}`)}${routed.thinkingLevel ? ` ${theme.fg("dim", `[${routed.thinkingLevel}]`)}` : ""}`
						: "";
					const thinkingPart = selectedThinking + routedPart;
					const usagePart = tokens !== null && percent !== null
						? `${theme.fg("dim", " | ")}${colorTokens(tokens, formatCount(tokens))} ${theme.fg("dim", `(${percent.toFixed(1)}%)`)}`
						: "";
					const statusParts = [bashGuardStatus(footerData), failoverStatus(footerData, theme)].filter(Boolean);
					const statusPart = statusParts.map((part) => `${theme.fg("dim", " | ")}${part}`).join("");
					const leftWidth = visibleWidth(left + thinkingPart + usagePart + statusPart);
					const memoryPart = formatMemorySnapshot(memoryView(state, footerData), theme, Math.max(0, width - leftWidth - 1));
					return [
						alignRow(left + thinkingPart + usagePart + statusPart, memoryPart, width),
						...nameRow(pi.getSessionName?.(), theme, width),
					];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => apply(ctx as SessionContext));
	pi.on("turn_start", async (_event, ctx) => void bind(ctx as SessionContext));
	pi.on("turn_end", async (_event, ctx) => void bind(ctx as SessionContext));
	pi.on("message_end", async (_event, ctx) => void bind(ctx as SessionContext));
	pi.on("model_select", async (_event, ctx) => void bind(ctx as SessionContext));
	pi.on("session_info_changed", async (_event, ctx) => bind(ctx as SessionContext).requestRender?.());
	pi.on("session_tree", async (_event, ctx) => bind(ctx as SessionContext).requestRender?.());

	pi.registerCommand("statusline", {
		description: "Toggle the Claude Code-style status line",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx as SessionContext);
			ctx.ui.notify(enabled ? "Claude Code-style status line enabled" : "Default footer restored", "info");
		},
	});
}
