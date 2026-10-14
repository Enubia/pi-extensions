import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ILink, type ITheme, Terminal } from "@xterm/xterm";
import type { FromWebview, ToWebview, WebviewSettings } from "./protocol";

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);
const settings = JSON.parse(document.getElementById("settings")?.textContent ?? "{}") as WebviewSettings;

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

function cssVar(name: string): string | undefined {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function theme(): ITheme {
	const background = cssVar("--vscode-terminal-background") ?? cssVar("--vscode-editor-background");
	const foreground = cssVar("--vscode-terminal-foreground") ?? cssVar("--vscode-editor-foreground");
	const colors: Record<string, string | undefined> = {
		background,
		foreground,
		cursor: cssVar("--vscode-terminalCursor-foreground") ?? foreground,
		cursorAccent: cssVar("--vscode-terminalCursor-background") ?? background,
		selectionBackground: cssVar("--vscode-terminal-selectionBackground") ?? cssVar("--vscode-editor-selectionBackground"),
	};
	for (const name of ANSI) {
		colors[name.toLowerCase()] = cssVar(`--vscode-terminal-ansi${name}`);
		colors[`bright${name}`] = cssVar(`--vscode-terminal-ansiBright${name}`);
	}
	return Object.fromEntries(Object.entries(colors).filter(([, value]) => value)) as ITheme;
}

function decodeBase64(value: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

const term = new Terminal({
	allowProposedApi: true,
	fontFamily: settings.fontFamily,
	fontSize: settings.fontSize,
	lineHeight: settings.lineHeight,
	macOptionIsMeta: settings.macOptionIsMeta,
	macOptionClickForcesSelection: true,
	scrollback: 10_000,
	theme: theme(),
	vtExtensions: { kittyKeyboard: true },
	linkHandler: { activate: (_event, url) => post({ type: "openUrl", url }) },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
term.loadAddon(new WebLinksAddon((_event, url) => post({ type: "openUrl", url })));

const FILE_LINK = /(?<![\w/.~-])((?:~|\.{1,2})?\/?[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@+-]+\.[A-Za-z][\w]{0,7})(?::(\d+)(?::(\d+))?)?/g;

term.registerLinkProvider({
	provideLinks(y, callback) {
		const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
		const links: ILink[] = [];
		for (const match of text.matchAll(FILE_LINK)) {
			if (/^https?:/.test(text.slice(Math.max(0, match.index - 8), match.index + 1))) continue;
			const [whole, file, line, column] = match;
			links.push({
				text: whole,
				range: { start: { x: match.index + 1, y }, end: { x: match.index + whole.length, y } },
				activate: () => post({ type: "openFile", path: file, line: line ? Number(line) : undefined, column: column ? Number(column) : undefined }),
			});
		}
		callback(links);
	},
});

term.parser.registerOscHandler(9, (data) => {
	if (data.startsWith("4;")) post({ type: "progress", state: Number(data.split(";")[1] ?? 0) });
	else post({ type: "notify", body: data });
	return true;
});

term.parser.registerOscHandler(777, (data) => {
	const [kind, title, ...body] = data.split(";");
	if (kind === "notify") post({ type: "notify", title, body: body.join(";") });
	return true;
});

term.parser.registerOscHandler(52, (data) => {
	const payload = data.split(";")[1];
	if (payload && payload !== "?") post({ type: "clipboard", text: decodeBase64(payload) });
	return true;
});

term.parser.registerOscHandler(1337, (data) => {
	const match = /^SetUserVar=([^=]+)=(.*)$/.exec(data);
	if (match) post({ type: "userVar", name: match[1], value: match[2] ? decodeBase64(match[2]) : "" });
	return true;
});

const isMac = navigator.platform.toLowerCase().includes("mac");
let lastKeyPaste = 0;

term.attachCustomKeyEventHandler((event) => {
	const pasteKey = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
	if (!pasteKey || event.altKey || (event.code !== "KeyV" && event.key.toLowerCase() !== "v")) return true;
	if (event.type === "keydown") {
		lastKeyPaste = Date.now();
		post({ type: "pasteRequest" });
	}
	return false;
});

document.addEventListener(
	"paste",
	(event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		if (Date.now() - lastKeyPaste > 1_000) post({ type: "pasteRequest" });
	},
	true,
);

function screenText(lines: number): string {
	const buffer = term.buffer.active;
	const rows: string[] = [];
	for (let y = 0; y < buffer.length; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
	while (rows.length && !rows[rows.length - 1]) rows.pop();
	return rows.slice(-lines).join("\n");
}

term.onTitleChange((title) => post({ type: "title", title }));
term.onData((data) => post({ type: "input", data }));
term.onBinary((data) => post({ type: "input", data }));
term.onResize(({ cols, rows }) => post({ type: "resize", cols, rows }));

const container = document.getElementById("terminal") as HTMLElement;
term.open(container);

if (settings.renderer === "webgl") {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => webgl.dispose());
		term.loadAddon(webgl);
	} catch {}
}

let fitQueued = false;
new ResizeObserver(() => {
	if (fitQueued) return;
	fitQueued = true;
	requestAnimationFrame(() => {
		fitQueued = false;
		fit.fit();
	});
}).observe(container);

new MutationObserver(() => {
	term.options.theme = theme();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

window.addEventListener("focus", () => term.focus());

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case "output":
			term.write(message.data);
			return;
		case "exit":
			term.write(`\r\n\x1b[2m[pi exited with code ${message.code}, press any key to close]\x1b[0m\r\n`);
			return;
		case "focus":
			term.focus();
			return;
		case "paste":
			if (message.text) term.paste(message.text);
			return;
		case "read":
			post({ type: "screen", id: message.id, text: screenText(message.lines) });
			return;
	}
});

fit.fit();
post({ type: "ready", cols: term.cols, rows: term.rows });
term.focus();
