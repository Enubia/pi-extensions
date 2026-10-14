import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FromWebview, ToWebview, WebviewSettings } from "./protocol";
import { allSessions, relativeTime, type SessionInfo, sessionLabel, sessionsForCwd, sessionsRoot } from "./session-index";
import { startSurfaceServer, type SurfaceServer } from "./surface-server";

type Pty = {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number }) => void): void;
};

type PtyModule = {
	spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): Pty;
};

type Attention = "input" | "done";

type Session = {
	id: number;
	cwd: string;
	panel: vscode.WebviewPanel;
	command: string;
	defaultTitle: string;
	title: string;
	busy: boolean;
	attention?: Attention;
	attentionText?: string;
	exited: boolean;
	proc?: Pty;
	file?: string;
	kind: "pi" | "shell";
	parentId?: number;
	pendingInput: string;
};

type CreateOptions = { resume?: SessionInfo; kind?: Session["kind"]; parent?: Session; title?: string };

type WorkspaceItem = vscode.TreeItem & { cwd: string };

type SessionItem = vscode.TreeItem & { sessionId: number };

const HISTORY_LIMIT = 15;

const sessions = new Map<number, Session>();
let nextId = 1;
let extensionUri: vscode.Uri;
let tree: SessionTree;
let ptyModule: PtyModule | undefined;
let surfaceServer: SurfaceServer | undefined;
let nextReadId = 1;
const pendingReads = new Map<number, (text: string) => void>();

const FOREIGN_MUX_ENV = /^(WEZTERM_|TMUX|ZELLIJ|CMUX_|KITTY_|ITERM_|TERM_PROGRAM_VERSION$|TERM_SESSION_ID$)/;

function loadPty(): PtyModule {
	if (ptyModule) return ptyModule;
	const errors: string[] = [];
	for (const dir of ["node_modules.asar", "node_modules"]) {
		try {
			return (ptyModule = require(path.join(vscode.env.appRoot, dir, "node-pty")) as PtyModule);
		} catch (error) {
			errors.push(`${dir}: ${(error as Error).message}`);
		}
	}
	throw new Error(`node-pty not loadable:\n${errors.join("\n")}`);
}

function webviewSettings(): WebviewSettings {
	const own = vscode.workspace.getConfiguration("piTabs");
	const terminal = vscode.workspace.getConfiguration("terminal.integrated");
	const editor = vscode.workspace.getConfiguration("editor");
	return {
		fontFamily: own.get<string>("fontFamily") || terminal.get<string>("fontFamily") || editor.get<string>("fontFamily") || "monospace",
		fontSize: own.get<number>("fontSize") || terminal.get<number>("fontSize") || editor.get<number>("fontSize") || 13,
		lineHeight: terminal.get<number>("lineHeight") || 1,
		macOptionIsMeta: own.get<boolean>("macOptionIsMeta") ?? false,
		renderer: own.get<"webgl" | "dom">("renderer") ?? "webgl",
	};
}

function post(session: Session, message: ToWebview) {
	void session.panel.webview.postMessage(message);
}

function marker(session: Session): string {
	if (session.exited) return "✕ ";
	if (session.attention === "input") return "❓ ";
	if (session.attention === "done") return "✓ ";
	if (session.busy) return "⋯ ";
	return "";
}

function render(session: Session) {
	session.panel.title = marker(session) + session.title;
	tree.refresh();
}

function isWatching(session: Session): boolean {
	return session.panel.active && vscode.window.state.focused;
}

function notify(session: Session, message: string) {
	if (isWatching(session)) return;
	void vscode.window.showInformationMessage(message, "Show").then((choice) => {
		if (choice) session.panel.reveal();
	});
}

function childEnv(session: Session): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_") || FOREIGN_MUX_ENV.test(key)) delete env[key];
	Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "vscode", PI_XTERM_SESSION: String(session.id) });
	if (surfaceServer) Object.assign(env, { PI_VSCODE_SOCKET: surfaceServer.socket, PI_SUBAGENT_MUX: "vscode" });
	return env;
}

function spawn(session: Session, cols: number, rows: number) {
	const shell = process.env.SHELL || "/bin/zsh";
	const bridge = vscode.Uri.joinPath(extensionUri, "pi", "vscode-bridge.ts").fsPath;
	const args = ["-e", bridge, ...(session.file ? ["--session", session.file] : [])];
	const shellArgs = session.kind === "shell" ? ["-l", "-i"] : ["-l", "-i", "-c", `exec ${session.command} "$@"`, "pi", ...args];
	const proc = loadPty().spawn(shell, shellArgs, {
		name: "xterm-256color",
		cols,
		rows,
		cwd: session.cwd,
		env: childEnv(session),
	});
	session.proc = proc;
	if (session.pendingInput) {
		proc.write(session.pendingInput);
		session.pendingInput = "";
	}

	let pending = "";
	let scheduled = false;
	proc.onData((data) => {
		pending += data;
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			const chunk = pending;
			pending = "";
			post(session, { type: "output", data: chunk });
		});
	});
	proc.onExit(({ exitCode }) => {
		session.exited = true;
		post(session, { type: "exit", code: exitCode });
		render(session);
	});
}

async function openFile(session: Session, file: string, line = 1, column = 1) {
	const resolved = path.resolve(session.cwd, file.replace(/^~(?=\/)/, os.homedir()));
	if (!fs.existsSync(resolved)) return;
	const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
	await vscode.window.showTextDocument(vscode.Uri.file(resolved), {
		viewColumn: vscode.ViewColumn.Beside,
		selection: new vscode.Range(position, position),
	});
}

function handleMessage(session: Session, message: FromWebview) {
	switch (message.type) {
		case "ready":
			if (session.proc) return;
			try {
				spawn(session, message.cols, message.rows);
			} catch (error) {
				session.exited = true;
				post(session, { type: "output", data: `\x1b[31m${String((error as Error).stack ?? error).replace(/\n/g, "\r\n")}\x1b[0m\r\n` });
				render(session);
			}
			return;
		case "input":
			if (session.exited) session.panel.dispose();
			else session.proc?.write(message.data);
			return;
		case "resize":
			if (!session.exited) session.proc?.resize(message.cols, message.rows);
			return;
		case "title":
			if (session.parentId !== undefined) return;
			session.title = message.title || session.defaultTitle;
			render(session);
			return;
		case "progress":
			session.busy = message.state !== 0;
			render(session);
			return;
		case "notify":
			notify(session, [message.title, message.body].filter(Boolean).join(": ") || session.title);
			return;
		case "clipboard":
			void vscode.env.clipboard.writeText(message.text);
			return;
		case "userVar":
			if (message.name === "pi_attention_text") session.attentionText = message.value;
			else if (message.name === "pi_attention") onAttention(session, message.value);
			else if (message.name === "pi_session_file") {
				session.file = message.value || undefined;
				tree.refresh();
			}
			return;
		case "openUrl":
			void vscode.env.openExternal(vscode.Uri.parse(message.url));
			return;
		case "openFile":
			void openFile(session, message.path, message.line, message.column);
			return;
		case "pasteRequest":
			void vscode.env.clipboard.readText().then((text) => post(session, { type: "paste", text }));
			return;
		case "screen":
			pendingReads.get(message.id)?.(message.text);
			return;
	}
}

function webviewHtml(webview: vscode.Webview, settings: WebviewSettings): string {
	const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
	const json = JSON.stringify(settings).replace(/</g, "\\u003c");
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${asset("dist", "webview.css")}">
<style>
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-terminal-background, var(--vscode-editor-background)); }
#terminal { position: absolute; inset: 4px 0 0 8px; }
</style>
</head>
<body>
<div id="terminal"></div>
<script id="settings" type="application/json">${json}</script>
<script src="${asset("dist", "webview.js")}"></script>
</body>
</html>`;
}

function openSessionFile(info: SessionInfo) {
	const open = [...sessions.values()].find((session) => session.file === info.file && !session.exited);
	if (open) return open.panel.reveal();
	createSession(fs.existsSync(info.cwd) ? info.cwd : os.homedir(), { resume: info });
}

function closeGroupIfEmpty(column: vscode.ViewColumn) {
	const group = vscode.window.tabGroups.all.find((candidate) => candidate.viewColumn === column);
	if (group && group.tabs.length === 0 && vscode.window.tabGroups.all.length > 1) void vscode.window.tabGroups.close(group);
}

function subagentColumn(parent: Session): vscode.ViewColumn {
	const sibling = [...sessions.values()].find((session) => session.parentId === parent.id && session.panel.viewColumn);
	if (sibling?.panel.viewColumn) return sibling.panel.viewColumn;
	return Math.min((parent.panel.viewColumn ?? vscode.ViewColumn.One) + 1, vscode.ViewColumn.Nine);
}

function createSession(cwd: string, { resume, kind = "pi", parent, title }: CreateOptions = {}): Session {
	const id = nextId++;
	const defaultTitle = title ?? (resume ? sessionLabel(resume) : `pi · ${path.basename(cwd)}`);
	const placement = parent ? { viewColumn: subagentColumn(parent), preserveFocus: true } : vscode.ViewColumn.Active;
	const panel = vscode.window.createWebviewPanel("piTabs", defaultTitle, placement, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [extensionUri],
	});
	panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "pi.svg");
	const command = vscode.workspace.getConfiguration("piTabs").get<string>("command") || "pi";
	const session: Session = { id, cwd, panel, command, defaultTitle, title: defaultTitle, busy: false, exited: false, file: resume?.file, kind, parentId: parent?.id, pendingInput: "" };
	sessions.set(id, session);
	panel.webview.html = webviewHtml(panel.webview, webviewSettings());
	panel.webview.onDidReceiveMessage((message: FromWebview) => handleMessage(session, message));
	panel.onDidChangeViewState(() => {
		if (!panel.active) return;
		post(session, { type: "focus" });
		if (session.attention === "done") {
			session.attention = undefined;
			render(session);
		}
	});
	let column = panel.viewColumn;
	panel.onDidChangeViewState(() => {
		column = panel.viewColumn ?? column;
	});
	panel.onDidDispose(() => {
		if (!session.exited) session.proc?.kill();
		sessions.delete(id);
		tree.refresh();
		const closedColumn = column;
		if (session.parentId !== undefined && closedColumn) setTimeout(() => closeGroupIfEmpty(closedColumn), 0);
	});
	tree.refresh();
	return session;
}

function onAttention(session: Session, token: string) {
	const state = token.split(":")[0];
	const text = session.attentionText || session.title;
	if (state === "input") {
		session.attention = "input";
		notify(session, `Pi needs input: ${text}`);
	} else if (state === "done" && session.parentId === undefined && !isWatching(session)) {
		session.attention = "done";
		notify(session, `Pi finished: ${text}`);
	} else {
		session.attention = undefined;
	}
	render(session);
}

function sessionStatus(session: Session): { description: string; icon: string } {
	if (session.exited) return { description: "exited", icon: "debug-stop" };
	if (session.attention === "input") return { description: "needs input", icon: "question" };
	if (session.attention === "done") return { description: "done", icon: "check" };
	if (session.busy) return { description: "working", icon: "loading~spin" };
	return { description: "", icon: "terminal" };
}

class SessionTree implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	refresh() {
		this.emitter.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		if (!element) return this.workspaces();
		if ("sessionId" in element) return children((element as SessionItem).sessionId).map((session) => this.sessionItem(session));
		const cwd = (element as WorkspaceItem).cwd;
		const open = rootSessions().filter((session) => session.cwd === cwd);
		const openFiles = new Set(open.map((session) => session.file));
		const history = (await sessionsForCwd(cwd)).filter((info) => !openFiles.has(info.file));
		const items = [...open.map((session) => this.sessionItem(session)), ...history.slice(0, HISTORY_LIMIT).map((info) => this.historyItem(info))];
		if (history.length > HISTORY_LIMIT) items.push(this.moreItem(cwd, history.length - HISTORY_LIMIT));
		return items;
	}

	private workspaces(): WorkspaceItem[] {
		const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
		const cwds = [...new Set([...folders, ...rootSessions().map((session) => session.cwd)])];
		return cwds.map((cwd) => {
			const item = new vscode.TreeItem(path.basename(cwd), vscode.TreeItemCollapsibleState.Expanded) as WorkspaceItem;
			item.id = `workspace:${cwd}`;
			item.cwd = cwd;
			item.description = cwd.replace(os.homedir(), "~");
			item.contextValue = "workspace";
			item.iconPath = new vscode.ThemeIcon("folder");
			return item;
		});
	}

	private sessionItem(session: Session): vscode.TreeItem {
		const status = sessionStatus(session);
		const nested = children(session.id).length > 0;
		const item = new vscode.TreeItem(session.title, nested ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None) as SessionItem;
		item.sessionId = session.id;
		item.id = `session:${session.id}`;
		item.description = status.description;
		item.iconPath = new vscode.ThemeIcon(status.icon);
		item.command = { command: "piTabs.reveal", title: "Show", arguments: [session.id] };
		return item;
	}

	private historyItem(info: SessionInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(sessionLabel(info), vscode.TreeItemCollapsibleState.None);
		item.id = `history:${info.file}`;
		item.description = relativeTime(info.modifiedAt);
		item.tooltip = new vscode.MarkdownString([`**${sessionLabel(info)}**`, info.name && info.firstMessage ? info.firstMessage : "", `\`${info.file}\``].filter(Boolean).join("\n\n"));
		item.iconPath = new vscode.ThemeIcon("history");
		item.contextValue = "history";
		item.command = { command: "piTabs.openSessionFile", title: "Open", arguments: [info] };
		return item;
	}

	private moreItem(cwd: string, remaining: number): vscode.TreeItem {
		const item = new vscode.TreeItem(`${remaining} more\u2026`, vscode.TreeItemCollapsibleState.None);
		item.id = `more:${cwd}`;
		item.iconPath = new vscode.ThemeIcon("search");
		item.command = { command: "piTabs.searchHere", title: "Search", arguments: [{ cwd }] };
		return item;
	}
}

type SessionPick = vscode.QuickPickItem & { info: SessionInfo };

function toPick(info: SessionInfo): SessionPick {
	const open = [...sessions.values()].some((session) => session.file === info.file && !session.exited);
	return {
		label: `${open ? "$(circle-filled) " : ""}${sessionLabel(info)}`,
		description: `${info.cwd.replace(os.homedir(), "~")} \u00b7 ${relativeTime(info.modifiedAt)}`,
		detail: info.name ? info.firstMessage : undefined,
		info,
	};
}

async function searchSessions(cwd?: string) {
	const pick = vscode.window.createQuickPick<SessionPick>();
	pick.placeholder = cwd ? `Search Pi sessions in ${path.basename(cwd)}` : "Search all Pi sessions";
	pick.matchOnDescription = true;
	pick.matchOnDetail = true;
	pick.busy = true;
	pick.onDidAccept(() => {
		const info = pick.selectedItems[0]?.info;
		pick.hide();
		if (info) openSessionFile(info);
	});
	pick.onDidHide(() => pick.dispose());
	pick.show();
	const update = (infos: SessionInfo[]) => {
		pick.items = infos.map(toPick);
	};
	update(cwd ? await sessionsForCwd(cwd) : await allSessions(update));
	pick.busy = false;
}

function watchSessions(): vscode.Disposable {
	let timer: NodeJS.Timeout | undefined;
	try {
		const watcher = fs.watch(sessionsRoot(), { recursive: true }, () => {
			clearTimeout(timer);
			timer = setTimeout(() => tree.refresh(), 1_000);
		});
		return { dispose: () => watcher.close() };
	} catch {
		return { dispose: () => {} };
	}
}

async function pickFolder(): Promise<string | undefined> {
	const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Start Pi here" });
	return uris?.[0]?.fsPath;
}

async function defaultFolder(): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const active = vscode.window.activeTextEditor?.document.uri;
	const owning = active && vscode.workspace.getWorkspaceFolder(active);
	if (owning) return owning.uri.fsPath;
	if (folders.length === 1) return folders[0].uri.fsPath;
	if (folders.length > 1) return (await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
	return pickFolder();
}

function children(parentId: number): Session[] {
	return [...sessions.values()].filter((session) => session.parentId === parentId);
}

function rootSessions(): Session[] {
	return [...sessions.values()].filter((session) => session.parentId === undefined || !sessions.has(session.parentId));
}

function surface(id: string): Session | undefined {
	return sessions.get(Number(id));
}

function readScreen(session: Session, lines: number): Promise<string> {
	const id = nextReadId++;
	return new Promise((resolve) => {
		const finish = (text: string) => {
			clearTimeout(timer);
			pendingReads.delete(id);
			resolve(text);
		};
		const timer = setTimeout(() => finish(""), 3_000);
		pendingReads.set(id, finish);
		post(session, { type: "read", id, lines });
	});
}

function serveSurfaces(): vscode.Disposable {
	surfaceServer = startSurfaceServer({
		create: ({ name, parent, cwd }) => {
			const parentSession = parent ? surface(parent) : undefined;
			const dir = cwd && fs.existsSync(cwd) ? cwd : (parentSession?.cwd ?? os.homedir());
			return String(createSession(dir, { kind: "shell", parent: parentSession, title: name }).id);
		},
		send: ({ surface: id, text }) => {
			const session = surface(id);
			if (!session || session.exited) return false;
			if (session.proc) session.proc.write(text);
			else session.pendingInput += text;
			return true;
		},
		read: async ({ surface: id, lines }) => {
			const session = surface(id);
			return session ? readScreen(session, lines) : undefined;
		},
		close: ({ surface: id }) => {
			const session = surface(id);
			session?.panel.dispose();
			return Boolean(session);
		},
		rename: ({ surface: id, title }) => {
			const session = surface(id);
			if (!session) return false;
			session.title = session.defaultTitle = title;
			render(session);
			return true;
		},
	});
	return surfaceServer;
}

export function activate(context: vscode.ExtensionContext) {
	extensionUri = context.extensionUri;
	tree = new SessionTree();
	context.subscriptions.push(
		serveSurfaces(),
		vscode.window.registerTreeDataProvider("piTabs.sessions", tree),
		vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
		vscode.window.onDidChangeWindowState(() => {
			for (const session of sessions.values()) {
				if (session.attention !== "done" || !isWatching(session)) continue;
				session.attention = undefined;
				render(session);
			}
		}),
		vscode.commands.registerCommand("piTabs.newSession", async () => {
			const cwd = await defaultFolder();
			if (cwd) createSession(cwd);
		}),
		vscode.commands.registerCommand("piTabs.newSessionInFolder", async () => {
			const cwd = await pickFolder();
			if (cwd) createSession(cwd);
		}),
		vscode.commands.registerCommand("piTabs.newSessionHere", (item?: WorkspaceItem) => {
			if (item?.cwd) createSession(item.cwd);
		}),
		vscode.commands.registerCommand("piTabs.reveal", (id: number) => sessions.get(id)?.panel.reveal()),
		vscode.commands.registerCommand("piTabs.openSessionFile", (info: SessionInfo) => openSessionFile(info)),
		vscode.commands.registerCommand("piTabs.search", () => searchSessions()),
		vscode.commands.registerCommand("piTabs.searchHere", (item?: { cwd: string }) => searchSessions(item?.cwd)),
		watchSessions(),
	);
}

export function deactivate() {
	for (const session of sessions.values()) if (!session.exited) session.proc?.kill();
}
