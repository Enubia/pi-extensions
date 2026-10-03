import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ResolvedCommand, ServerSpec } from "./registry.ts";
import { languageIdFor } from "./registry.ts";
import { JsonRpcTransport, LspError } from "./transport.ts";
import type { Diagnostic, Location, LocationLink, Position, ServerCapabilities, SymbolInformation, DocumentSymbol, Hover, WorkspaceSymbol, DocumentDiagnosticReport } from "./types.ts";

export type ClientState = "starting" | "ready" | "failed" | "stopped";

interface OpenDocument {
	version: number;
	text: string;
}

const MAX_OPEN_DOCUMENTS = 60;

export class LspClient {
	readonly root: string;
	readonly spec: ServerSpec;
	readonly command: ResolvedCommand;
	state: ClientState = "starting";
	lastError?: string;
	capabilities: ServerCapabilities = {};
	private readonly transport: JsonRpcTransport;
	private readonly ready: Promise<void>;
	private readonly documents = new Map<string, OpenDocument>();
	private readonly pushedDiagnostics = new Map<string, Diagnostic[]>();
	private readonly pushWaiters = new Map<string, Set<() => void>>();
	private readonly stderrTail: string[] = [];

	constructor(spec: ServerSpec, root: string, command: ResolvedCommand) {
		this.spec = spec;
		this.root = root;
		this.command = command;
		this.transport = new JsonRpcTransport({
			command: command.command,
			args: command.args,
			cwd: root,
			requestTimeoutMs: spec.requestTimeoutMs ?? 30_000,
			onExit: () => {
				if (this.state !== "stopped") {
					this.state = "failed";
					this.lastError ??= `exited unexpectedly${this.stderrTail.length ? `: ${this.stderrTail.join(" ").slice(-300)}` : ""}`;
				}
			},
			onStderr: (text) => {
				this.stderrTail.push(text.trim());
				if (this.stderrTail.length > 5) this.stderrTail.shift();
			},
		});
		this.transport.onRequest("workspace/configuration", (params) => {
			const items = (params as { items?: unknown[] })?.items ?? [];
			return items.map(() => this.spec.settings ?? null);
		});
		this.transport.onRequest("client/registerCapability", () => null);
		this.transport.onRequest("client/unregisterCapability", () => null);
		this.transport.onRequest("window/workDoneProgress/create", () => null);
		this.transport.onRequest("window/showMessageRequest", () => null);
		this.transport.onNotification("textDocument/publishDiagnostics", (params) => {
			const p = params as { uri: string; diagnostics: Diagnostic[] };
			if (!this.documents.has(p.uri)) return;
			this.pushedDiagnostics.set(p.uri, p.diagnostics);
			for (const wake of this.pushWaiters.get(p.uri) ?? []) wake();
		});
		this.ready = this.initialize();
	}

	get pid(): number | undefined {
		return this.transport.pid;
	}

	get openDocumentCount(): number {
		return this.documents.size;
	}

	whenReady(): Promise<void> {
		return this.ready;
	}

	private async initialize(): Promise<void> {
		const rootUri = pathToFileURL(this.root).href;
		try {
			const result = await this.transport.request<{ capabilities: ServerCapabilities }>(
				"initialize",
				{
				processId: process.pid,
				clientInfo: { name: "pi-lsp", version: "0.1.0" },
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() ?? "root" }],
				initializationOptions: this.spec.initializationOptions,
				capabilities: {
					workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
					textDocument: {
						synchronization: { didSave: false, dynamicRegistration: false },
						publishDiagnostics: { relatedInformation: false, versionSupport: true },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					},
					window: { workDoneProgress: false },
				},
				},
				undefined,
				this.spec.startupTimeoutMs ?? 30_000,
			);
			this.capabilities = result.capabilities ?? {};
			this.transport.notify("initialized", {});
			if (this.spec.settings !== undefined) this.transport.notify("workspace/didChangeConfiguration", { settings: this.spec.settings });
			this.state = "ready";
		} catch (error) {
			this.state = "failed";
			this.lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	get supportsPullDiagnostics(): boolean {
		return Boolean(this.capabilities.diagnosticProvider);
	}

	uriFor(filePath: string): string {
		return pathToFileURL(filePath).href;
	}

	sync(filePath: string, text?: string): void {
		const uri = this.uriFor(filePath);
		const content = text ?? this.readSafe(filePath);
		if (content === undefined) return;
		const existing = this.documents.get(uri);
		if (existing) {
			this.documents.delete(uri);
			this.documents.set(uri, existing);
			if (existing.text === content) return;
			existing.version += 1;
			existing.text = content;
			this.transport.notify("textDocument/didChange", {
				textDocument: { uri, version: existing.version },
				contentChanges: [{ text: content }],
			});
			return;
		}
		this.evictIfNeeded();
		this.documents.set(uri, { version: 1, text: content });
		this.transport.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: languageIdFor(this.spec, filePath), version: 1, text: content },
		});
	}

	close(filePath: string): void {
		const uri = this.uriFor(filePath);
		if (!this.documents.delete(uri)) return;
		this.transport.notify("textDocument/didClose", { textDocument: { uri } });
		this.pushedDiagnostics.delete(uri);
	}

	async diagnostics(filePath: string, signal?: AbortSignal, maxWaitMs?: number): Promise<Diagnostic[]> {
		this.sync(filePath);
		const uri = this.uriFor(filePath);
		const budget = maxWaitMs ?? this.spec.diagnosticsMaxWaitMs ?? 5_000;
		if (this.supportsPullDiagnostics) {
			const report = await this.transport.request<DocumentDiagnosticReport>("textDocument/diagnostic", { textDocument: { uri } }, signal, budget);
			if (report?.kind === "full") return report.items;
			return this.pushedDiagnostics.get(uri) ?? [];
		}
		await this.awaitPushedDiagnostics(uri, budget, signal);
		return this.pushedDiagnostics.get(uri) ?? [];
	}

	private async awaitPushedDiagnostics(uri: string, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
		const settleMs = this.spec.diagnosticsSettleMs ?? 500;
		const deadline = Date.now() + maxWaitMs;
		let received = false;
		while (!signal?.aborted) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			const arrived = await this.waitForPush(uri, received ? Math.min(settleMs, remaining) : remaining, signal);
			if (!arrived) return;
			received = true;
		}
	}

	private waitForPush(uri: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			const waiters = this.pushWaiters.get(uri) ?? new Set();
			this.pushWaiters.set(uri, waiters);
			const finish = (arrived: boolean) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				waiters.delete(wake);
				if (waiters.size === 0) this.pushWaiters.delete(uri);
				resolve(arrived);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			const onAbort = () => finish(false);
			const wake = () => finish(true);
			signal?.addEventListener("abort", onAbort, { once: true });
			waiters.add(wake);
		});
	}

	async hover(filePath: string, position: Position, signal?: AbortSignal): Promise<Hover | null> {
		this.sync(filePath);
		return this.transport.request<Hover | null>("textDocument/hover", { textDocument: { uri: this.uriFor(filePath) }, position }, signal);
	}

	async definition(filePath: string, position: Position, signal?: AbortSignal): Promise<Location[]> {
		this.sync(filePath);
		const result = await this.transport.request<Location | Location[] | LocationLink[] | null>(
			"textDocument/definition",
			{ textDocument: { uri: this.uriFor(filePath) }, position },
			signal,
		);
		return normalizeLocations(result);
	}

	async references(filePath: string, position: Position, includeDeclaration: boolean, signal?: AbortSignal): Promise<Location[]> {
		this.sync(filePath);
		const result = await this.transport.request<Location[] | null>(
			"textDocument/references",
			{ textDocument: { uri: this.uriFor(filePath) }, position, context: { includeDeclaration } },
			signal,
		);
		return result ?? [];
	}

	async documentSymbols(filePath: string, signal?: AbortSignal): Promise<DocumentSymbol[] | SymbolInformation[]> {
		this.sync(filePath);
		const result = await this.transport.request<DocumentSymbol[] | SymbolInformation[] | null>(
			"textDocument/documentSymbol",
			{ textDocument: { uri: this.uriFor(filePath) } },
			signal,
		);
		return result ?? [];
	}

	async workspaceSymbols(query: string, signal?: AbortSignal): Promise<WorkspaceSymbol[]> {
		if (!this.capabilities.workspaceSymbolProvider) throw new LspError(`${this.spec.id} does not support workspace symbols`);
		const result = await this.transport.request<WorkspaceSymbol[] | null>("workspace/symbol", { query }, signal);
		return result ?? [];
	}

	async dispose(): Promise<void> {
		this.state = "stopped";
		await this.transport.dispose();
	}

	private readSafe(filePath: string): string | undefined {
		try {
			return readFileSync(filePath, "utf8");
		} catch {
			return undefined;
		}
	}

	private evictIfNeeded(): void {
		if (this.documents.size < MAX_OPEN_DOCUMENTS) return;
		const oldest = this.documents.keys().next().value;
		if (!oldest) return;
		this.documents.delete(oldest);
		this.pushedDiagnostics.delete(oldest);
		this.transport.notify("textDocument/didClose", { textDocument: { uri: oldest } });
	}
}

export function normalizeLocations(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
	if (!result) return [];
	const list = Array.isArray(result) ? result : [result];
	return list.map((item) =>
		"targetUri" in item ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : item,
	);
}
