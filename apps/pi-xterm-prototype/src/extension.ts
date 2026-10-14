import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FromWebview, ToWebview, WebviewSettings } from "./protocol";
import { allSessions, relativeTime, type SessionInfo, sessionLabel, sessionsForCwd, sessionsRoot } from "./session-index";

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

type AttentionRecord = { pid: number; state: Attention; token: string; label: string; question?: string };

type Session = {
	id: number;
	cwd: string;
	panel: vscode.WebviewPanel;
	command: string;
	defaultTitle: string;
	title: string;
	busy: boolean;
	attention?: Attention;
	attentionToken?: string;
	exited: boolean;
	proc?: Pty;
	file?: string;
};

type WorkspaceItem = vscode.TreeItem & { cwd: string };

const HISTORY_LIMIT = 15;

const ATTENTION_DIR = process.env.PI_ATTENTION_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "attention");

const sessions = new Map<number, Session>();
const attentionFiles = new Map<string, number>();
let nextId = 1;
let extensionUri: vscode.Uri;
let tree: SessionTree;
let ptyModule: PtyModule | undefined;

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
	const own = vscode.workspace.getConfiguration("piXterm");
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
	const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "vscode", PI_XTERM_SESSION: String(session.id) };
	for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_")) delete env[key];
	return env;
}

function spawn(session: Session, cols: number, rows: number) {
	const shell = process.env.SHELL || "/bin/zsh";
	const bridge = vscode.Uri.joinPath(extensionUri, "pi", "vscode-bridge.ts").fsPath;
	const args = ["-e", bridge, ...(session.file ? ["--session", session.file] : [])];
	const proc = loadPty().spawn(shell, ["-l", "-i", "-c", `exec ${session.command} "$@"`, "pi", ...args], {
		name: "xterm-256color",
		cols,
		rows,
		cwd: session.cwd,
		env: childEnv(session),
	});
	session.proc = proc;

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
			if (message.name !== "pi_session_file") return;
			session.file = message.value || undefined;
			tree.refresh();
			return;
		case "openUrl":
			void vscode.env.openExternal(vscode.Uri.parse(message.url));
			return;
		case "openFile":
			void openFile(session, message.path, message.line, message.column);
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
	createSession(fs.existsSync(info.cwd) ? info.cwd : os.homedir(), info);
}

function createSession(cwd: string, resume?: SessionInfo): Session {
	const id = nextId++;
	const defaultTitle = resume ? sessionLabel(resume) : `pi · ${path.basename(cwd)}`;
	const panel = vscode.window.createWebviewPanel("piXterm", defaultTitle, vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [extensionUri],
	});
	panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "pi.svg");
	const command = vscode.workspace.getConfiguration("piXterm").get<string>("command") || "pi";
	const session: Session = { id, cwd, panel, command, defaultTitle, title: defaultTitle, busy: false, exited: false, file: resume?.file };
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
	panel.onDidDispose(() => {
		if (!session.exited) session.proc?.kill();
		sessions.delete(id);
		tree.refresh();
	});
	tree.refresh();
	return session;
}

function parentPid(pid: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "ppid=", "-p", String(pid)], (error, stdout) => resolve(error ? undefined : Number(stdout.trim()) || undefined));
	});
}

async function sessionForPid(pid: number): Promise<Session | undefined> {
	let current: number | undefined = pid;
	for (let depth = 0; current && current > 1 && depth < 6; depth++) {
		for (const session of sessions.values()) if (session.proc?.pid === current) return session;
		current = await parentPid(current);
	}
	return undefined;
}

function readAttention(file: string): AttentionRecord | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(ATTENTION_DIR, file), "utf8")) as AttentionRecord;
	} catch {
		return undefined;
	}
}

async function onAttentionFile(file: string) {
	const record = readAttention(file);
	if (!record) {
		const session = sessions.get(attentionFiles.get(file) ?? -1);
		attentionFiles.delete(file);
		if (session?.attention) {
			session.attention = undefined;
			render(session);
		}
		return;
	}
	const session = await sessionForPid(record.pid);
	if (!session || session.attentionToken === record.token) return;
	attentionFiles.set(file, session.id);
	session.attentionToken = record.token;
	if (record.state === "input") {
		session.attention = "input";
		notify(session, `Pi needs input: ${record.question || record.label}`);
	} else if (record.state === "done" && !isWatching(session)) {
		session.attention = "done";
		notify(session, `Pi finished: ${record.label}`);
	}
	render(session);
}

function watchAttention(): vscode.Disposable {
	fs.mkdirSync(ATTENTION_DIR, { recursive: true });
	const watcher = fs.watch(ATTENTION_DIR, (_event, file) => {
		if (file?.endsWith(".json")) void onAttentionFile(file);
	});
	return { dispose: () => watcher.close() };
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
		const cwd = (element as WorkspaceItem).cwd;
		const open = [...sessions.values()].filter((session) => session.cwd === cwd);
		const openFiles = new Set(open.map((session) => session.file));
		const history = (await sessionsForCwd(cwd)).filter((info) => !openFiles.has(info.file));
		const items = [...open.map((session) => this.sessionItem(session)), ...history.slice(0, HISTORY_LIMIT).map((info) => this.historyItem(info))];
		if (history.length > HISTORY_LIMIT) items.push(this.moreItem(cwd, history.length - HISTORY_LIMIT));
		return items;
	}

	private workspaces(): WorkspaceItem[] {
		const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
		const cwds = [...new Set([...folders, ...[...sessions.values()].map((session) => session.cwd)])];
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
		const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
		item.id = `session:${session.id}`;
		item.description = status.description;
		item.iconPath = new vscode.ThemeIcon(status.icon);
		item.command = { command: "piXterm.reveal", title: "Show", arguments: [session.id] };
		return item;
	}

	private historyItem(info: SessionInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(sessionLabel(info), vscode.TreeItemCollapsibleState.None);
		item.id = `history:${info.file}`;
		item.description = relativeTime(info.modifiedAt);
		item.tooltip = new vscode.MarkdownString([`**${sessionLabel(info)}**`, info.name && info.firstMessage ? info.firstMessage : "", `\`${info.file}\``].filter(Boolean).join("\n\n"));
		item.iconPath = new vscode.ThemeIcon("history");
		item.contextValue = "history";
		item.command = { command: "piXterm.openSessionFile", title: "Open", arguments: [info] };
		return item;
	}

	private moreItem(cwd: string, remaining: number): vscode.TreeItem {
		const item = new vscode.TreeItem(`${remaining} more\u2026`, vscode.TreeItemCollapsibleState.None);
		item.id = `more:${cwd}`;
		item.iconPath = new vscode.ThemeIcon("search");
		item.command = { command: "piXterm.searchHere", title: "Search", arguments: [{ cwd }] };
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

export function activate(context: vscode.ExtensionContext) {
	extensionUri = context.extensionUri;
	tree = new SessionTree();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("piXterm.sessions", tree),
		vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
		vscode.window.onDidChangeWindowState(() => {
			for (const session of sessions.values()) {
				if (session.attention !== "done" || !isWatching(session)) continue;
				session.attention = undefined;
				render(session);
			}
		}),
		vscode.commands.registerCommand("piXterm.newSession", async () => {
			const cwd = await defaultFolder();
			if (cwd) createSession(cwd);
		}),
		vscode.commands.registerCommand("piXterm.newSessionInFolder", async () => {
			const cwd = await pickFolder();
			if (cwd) createSession(cwd);
		}),
		vscode.commands.registerCommand("piXterm.newSessionHere", (item?: WorkspaceItem) => {
			if (item?.cwd) createSession(item.cwd);
		}),
		vscode.commands.registerCommand("piXterm.reveal", (id: number) => sessions.get(id)?.panel.reveal()),
		vscode.commands.registerCommand("piXterm.openSessionFile", (info: SessionInfo) => openSessionFile(info)),
		vscode.commands.registerCommand("piXterm.search", () => searchSessions()),
		vscode.commands.registerCommand("piXterm.searchHere", (item?: { cwd: string }) => searchSessions(item?.cwd)),
		watchAttention(),
		watchSessions(),
	);
}

export function deactivate() {
	for (const session of sessions.values()) if (!session.exited) session.proc?.kill();
}
