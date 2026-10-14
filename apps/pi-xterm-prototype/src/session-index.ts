import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type SessionInfo = {
	file: string;
	id: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	modifiedAt: number;
};

type Header = { id: string; cwd: string };

type ScanState = { name?: string; firstMessage?: string };

type CacheEntry = { mtimeMs: number; size: number; scannedBytes: number; header: Header | undefined; state: ScanState };

const HEADER_BYTES = 4 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 10;
const NAME_MARKER = Buffer.from('"type":"session_info"');
const USER_MARKER = Buffer.from('"role":"user"');

const cache = new Map<string, CacheEntry>();

export function sessionsRoot(): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "sessions");
}

export function sessionDirFor(cwd: string): string {
	return path.join(sessionsRoot(), `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

async function readRange(handle: fs.FileHandle, start: number, length: number): Promise<string> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, start);
	return buffer.subarray(0, bytesRead).toString("utf8");
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function userText(entry: Record<string, unknown> | undefined): string | undefined {
	const message = entry?.message as { role?: string; content?: unknown } | undefined;
	if (entry?.type !== "message" || message?.role !== "user") return undefined;
	const content = message.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text: string }).text : "").join(" ") : "";
	return text.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

function scanLines(buffer: Buffer, state: ScanState) {
	for (const marker of state.firstMessage ? [NAME_MARKER] : [NAME_MARKER, USER_MARKER]) {
		let at = buffer.indexOf(marker);
		while (at !== -1) {
			const lineStart = buffer.lastIndexOf(NEWLINE, at) + 1;
			const newline = buffer.indexOf(NEWLINE, at);
			const lineEnd = newline === -1 ? buffer.length : newline;
			const entry = parseLine(buffer.toString("utf8", lineStart, lineEnd));
			if (marker === NAME_MARKER) {
				if (typeof entry?.name === "string" && entry.name.trim()) state.name = entry.name.trim();
			} else {
				const text = userText(entry);
				if (text) {
					state.firstMessage = text;
					break;
				}
			}
			at = buffer.indexOf(marker, lineEnd);
		}
	}
}

async function scan(handle: fs.FileHandle, start: number, size: number, state: ScanState): Promise<number> {
	const chunk = Buffer.alloc(CHUNK_BYTES);
	let offset = start;
	let carry = Buffer.alloc(0);
	while (offset < size) {
		const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - offset), offset);
		if (!bytesRead) break;
		offset += bytesRead;
		const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
		const lastNewline = data.lastIndexOf(NEWLINE);
		if (lastNewline !== -1) scanLines(data.subarray(0, lastNewline + 1), state);
		carry = Buffer.from(data.subarray(lastNewline + 1));
	}
	return offset - carry.length;
}

async function readHeader(handle: fs.FileHandle): Promise<Header | undefined> {
	const head = await readRange(handle, 0, HEADER_BYTES);
	const header = parseLine(head.split("\n", 1)[0]);
	if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
	return { id: header.id, cwd: header.cwd };
}

async function refresh(file: string, size: number, mtimeMs: number, previous: CacheEntry | undefined): Promise<CacheEntry> {
	const handle = await fs.open(file, "r");
	try {
		const incremental = previous?.header && size >= previous.scannedBytes;
		const header = incremental ? previous.header : await readHeader(handle);
		const state: ScanState = incremental ? { ...previous.state } : {};
		const scannedBytes = header ? await scan(handle, incremental ? previous.scannedBytes : 0, size, state) : size;
		return { mtimeMs, size, scannedBytes, header, state };
	} finally {
		await handle.close();
	}
}

async function indexFile(file: string): Promise<SessionInfo | undefined> {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat) {
		cache.delete(file);
		return undefined;
	}
	let entry = cache.get(file);
	if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
		entry = await refresh(file, stat.size, stat.mtimeMs, entry).catch(() => undefined);
		if (!entry) return undefined;
		cache.set(file, entry);
	}
	const { header, state } = entry;
	if (!header || (!state.name && !state.firstMessage)) return undefined;
	return { file, id: header.id, cwd: header.cwd, name: state.name, firstMessage: state.firstMessage, modifiedAt: entry.mtimeMs };
}

const CONCURRENCY = 32;
const SUBAGENT_FILE = /_[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+\.jsonl$/;

async function indexDirectory(dir: string): Promise<SessionInfo[]> {
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const files = names.filter((name) => name.endsWith(".jsonl") && !SUBAGENT_FILE.test(name)).map((name) => path.join(dir, name));
	const results: SessionInfo[] = [];
	for (let index = 0; index < files.length; index += CONCURRENCY) {
		const infos = await Promise.all(files.slice(index, index + CONCURRENCY).map(indexFile));
		for (const info of infos) if (info) results.push(info);
	}
	return results;
}

function byRecency(a: SessionInfo, b: SessionInfo) {
	return b.modifiedAt - a.modifiedAt;
}

export async function sessionsForCwd(cwd: string): Promise<SessionInfo[]> {
	const infos = await indexDirectory(sessionDirFor(cwd));
	return infos.filter((info) => info.cwd === cwd).sort(byRecency);
}

export async function allSessions(onProgress?: (partial: SessionInfo[]) => void): Promise<SessionInfo[]> {
	const root = sessionsRoot();
	const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	const results: SessionInfo[] = [];
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		results.push(...(await indexDirectory(path.join(root, dir.name))));
		onProgress?.([...results].sort(byRecency));
	}
	return results.sort(byRecency);
}

export function sessionLabel(info: SessionInfo): string {
	return info.name ?? info.firstMessage ?? info.id;
}

export function relativeTime(timestamp: number): string {
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(timestamp).toLocaleDateString();
}
