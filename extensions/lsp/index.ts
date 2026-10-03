import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isEditToolResult, isReadToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { displayPath, errorsOnly, formatDiagnostics } from "./format.ts";
import { LspManager } from "./manager.ts";
import { registerLspTools } from "./tools.ts";

const AUTO_DIAGNOSTICS_MAX_LINES = 10;
const AUTO_DIAGNOSTICS_MAX_WAIT_MS = 3_000;

export default function lsp(pi: ExtensionAPI) {
	let manager: LspManager | undefined;

	const getManager = (ctx: ExtensionContext): LspManager => {
		manager ??= LspManager.fromConfig({
			cwd: ctx.cwd,
			isProjectTrusted: () => ctx.isProjectTrusted(),
			configPaths: [join(getAgentDir(), "lsp.json"), join(ctx.cwd, ".pi", "lsp.json")],
		});
		return manager;
	};

	pi.on("session_start", (_event, ctx) => {
		const m = getManager(ctx);
		if (m.warnings.length && ctx.hasUI) ctx.ui.notify(`[lsp] config ignored:\n${m.warnings.join("\n")}`, "warning");
	});

	pi.on("session_shutdown", async () => {
		await manager?.dispose();
		manager = undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		const path = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!path) return;
		const m = getManager(ctx);
		if (!isReadToolResult(event) && !isWriteToolResult(event) && !isEditToolResult(event)) return;
		const target = m.resolveTarget(path);
		if (!target) return;
		const client = m.runningClientFor(path);
		if (!client) {
			m.warm(target);
			return;
		}
		if (isReadToolResult(event)) {
			client.sync(target.absolutePath);
			return;
		}
		try {
			const diagnostics = errorsOnly(await client.diagnostics(target.absolutePath, ctx.signal, AUTO_DIAGNOSTICS_MAX_WAIT_MS));
			if (diagnostics.length === 0) return;
			const rel = displayPath(target.absolutePath, m.cwd);
			const lines = formatDiagnostics(diagnostics, rel).split("\n");
			const shown = lines.slice(0, AUTO_DIAGNOSTICS_MAX_LINES);
			if (lines.length > shown.length) shown.push(`... ${lines.length - shown.length} more errors`);
			return { content: [...event.content, { type: "text", text: `\n[lsp] ${diagnostics.length} error(s) in ${rel}:\n${shown.join("\n")}` }] };
		} catch {}
	});

	registerLspTools(pi, getManager);

	pi.registerCommand("lsp", {
		description: "Language servers: /lsp [status|restart [id]|list|servers]",
		getArgumentCompletions: (prefix) => {
			const items = ["status", "restart", "list", "servers"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const m = getManager(ctx);
			const [sub = "status", arg] = (args ?? "").trim().split(/\s+/);
			if (sub === "restart") {
				const n = await m.restart(arg || undefined);
				ctx.ui.notify(`Stopped ${n} language server(s); they restart on next use.`, "info");
				return;
			}
			if (sub === "list" || sub === "servers") {
				const lines = m.specs.map((s) => `${s.id}: ${Object.keys(s.languageIds).join(" ")}`);
				ctx.ui.notify(lines.join("\n") || "No servers configured.", "info");
				return;
			}
			const clients = m.allClients();
			const extra = [...m.failedServers().map((f) => `failed ${f}`), ...m.warnings.map((w) => `config warning ${w}`)];
			if (clients.length === 0) {
				ctx.ui.notify(["No language servers running. They start lazily on first lsp_* tool use.", ...extra].join("\n"), "info");
				return;
			}
			const lines = clients.map((c) => {
				const cmd = `${c.command.command} ${c.command.args.join(" ")}`.trim();
				const pull = c.state === "ready" ? (c.supportsPullDiagnostics ? " pull-diag" : " push-diag") : "";
				const err = c.lastError ? ` — ${c.lastError}` : "";
				return `${c.spec.id} [${c.state}${pull}] pid=${c.pid ?? "?"} docs=${c.openDocumentCount} root=${displayPath(c.root, m.cwd) || "."} cmd=${cmd}${err}`;
			});
			ctx.ui.notify([...lines, ...extra].join("\n"), "info");
		},
	});
}
