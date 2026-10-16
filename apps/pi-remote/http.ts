import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isAllowedAddress, isAuthorized } from "./access.ts";
import { RequestError, type Hub, type HubEvent, type ReplyMessage, type RequestPayload } from "./hub.ts";

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
};

const ERROR_STATUS: Record<string, number> = {
	unknown_session: 404,
	incompatible: 409,
	stale: 409,
	bad_request: 400,
	timeout: 504,
};

export type HttpAppOptions = {
	hub: Hub;
	token: string;
	webRoot: string;
	audit(line: string): void;
	allowAddress?(address: string | undefined): boolean;
	heartbeatMs?: number;
};

export type HttpApp = { server: Server; close(): void };

type Client = { res: ServerResponse; subscriptions: Set<number>; heartbeat: NodeJS.Timeout };

class HttpError extends Error {
	status: number;
	code: string | undefined;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

function normalizeAddress(address: string | undefined): string {
	if (!address) return "unknown";
	return address.replace(/^::ffff:/i, "");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
		chunks.push(buffer);
	}
	if (size === 0) return {};
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "body must be a JSON object");
	return value as Record<string, unknown>;
}

function buildPayload(action: string, body: Record<string, unknown>): RequestPayload {
	switch (action) {
		case "snapshot":
			if (body.before !== undefined && typeof body.before !== "string") throw new HttpError(400, "before must be a string");
			if (body.limit !== undefined && typeof body.limit !== "number") throw new HttpError(400, "limit must be a number");
			return { type: "snapshot", ...(body.before === undefined ? {} : { before: body.before }), ...(body.limit === undefined ? {} : { limit: body.limit }) };
		case "send":
			if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
			if (body.mode !== "auto" && body.mode !== "followUp") throw new HttpError(400, "mode must be auto or followUp");
			return { type: "send", text: body.text, mode: body.mode };
		case "abort":
			return { type: "abort" };
		case "answer":
			if (typeof body.toolCallId !== "string" || !body.toolCallId) throw new HttpError(400, "toolCallId is required");
			if (!Array.isArray(body.answers) || body.answers.length === 0) throw new HttpError(400, "answers must be a non-empty list");
			return { type: "answer", toolCallId: body.toolCallId, answers: body.answers as never };
		default:
			throw new HttpError(404, "not found");
	}
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
	const { hub, token, audit } = options;
	const allow = options.allowAddress ?? isAllowedAddress;
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const webRoot = resolve(options.webRoot);
	const clients = new Map<string, Client>();

	const writeEvent = (client: Client, event: string, data: unknown) => {
		if (!client.res.destroyed) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	const onHubEvent = (event: HubEvent) => {
		if (event.type === "sessions") {
			const payload = { sessions: hub.list() };
			for (const client of clients.values()) writeEvent(client, "sessions", payload);
			return;
		}
		for (const client of clients.values()) {
			if (!client.subscriptions.has(event.pid)) continue;
			if (event.type === "entry") writeEvent(client, "entry", { pid: event.pid, entry: event.entry });
			else writeEvent(client, "text_delta", { pid: event.pid, id: event.id, delta: event.delta });
		}
	};
	const unsubscribeHub = hub.subscribe(onHubEvent);

	const openStream = (req: IncomingMessage, res: ServerResponse) => {
		const address = normalizeAddress(req.socket.remoteAddress);
		const agent = req.headers["user-agent"] ?? "unknown";
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		const clientId = randomUUID();
		const heartbeat = setInterval(() => {
			if (!res.destroyed) res.write(": keepalive\n\n");
		}, heartbeatMs);
		heartbeat.unref();
		const client: Client = { res, subscriptions: new Set(), heartbeat };
		clients.set(clientId, client);
		audit(`${address} connected (${agent})`);
		res.on("close", () => {
			clearInterval(heartbeat);
			if (clients.delete(clientId)) audit(`${address} disconnected (${agent})`);
		});
		writeEvent(client, "ready", { clientId });
		writeEvent(client, "sessions", { sessions: hub.list() });
	};

	const actionLabel = (pid: number, payload: RequestPayload): string => {
		if (payload.type === "send") {
			if (payload.mode === "followUp") return "followUp";
			return hub.list().find((session) => session.pid === pid)?.state !== "idle" ? "steer" : "prompt";
		}
		return payload.type;
	};

	const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
		if (req.method !== "POST") throw new HttpError(405, "method not allowed");
		const body = await readJson(req);
		if (pathname === "/api/subscribe") {
			const client = typeof body.clientId === "string" ? clients.get(body.clientId) : undefined;
			if (!client) throw new HttpError(404, "unknown client");
			if (!Array.isArray(body.pids) || !body.pids.every((pid) => Number.isInteger(pid))) throw new HttpError(400, "pids must be a list of integers");
			client.subscriptions = new Set(body.pids as number[]);
			sendJson(res, 200, { ok: true });
			return;
		}
		const match = /^\/api\/sessions\/(\d+)\/([a-z]+)$/.exec(pathname);
		if (!match) throw new HttpError(404, "not found");
		const pid = Number(match[1]);
		const payload = buildPayload(match[2], body);
		const label = hub.list().find((session) => session.pid === pid)?.label ?? `pid ${pid}`;
		const kind = actionLabel(pid, payload);
		let reply: ReplyMessage;
		try {
			reply = await hub.request(pid, payload);
		} catch (error) {
			if (error instanceof RequestError) {
				if (payload.type !== "snapshot") audit(`${normalizeAddress(req.socket.remoteAddress)} ${kind} → ${label} failed (${error.code})`);
				throw new HttpError(ERROR_STATUS[error.code] ?? 502, error.message, error.code);
			}
			throw error;
		}
		if (payload.type !== "snapshot") audit(`${normalizeAddress(req.socket.remoteAddress)} ${kind} → ${label}`);
		if (reply.type === "snapshot_result") sendJson(res, 200, { entries: reply.entries, hasMore: reply.hasMore });
		else sendJson(res, 200, { ok: true });
	};

	const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
		if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			throw new HttpError(400, "bad path");
		}
		if (decoded.includes("\0")) throw new HttpError(404, "not found");
		const relative = decoded === "/" ? "/index.html" : decoded;
		const file = resolve(join(webRoot, `.${relative}`));
		if (!file.startsWith(webRoot + sep)) throw new HttpError(404, "not found");
		let content: Buffer;
		try {
			if (!(await stat(file)).isFile()) throw new Error("not a file");
			content = await readFile(file);
		} catch {
			throw new HttpError(404, "not found");
		}
		res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "content-length": content.length });
		res.end(req.method === "HEAD" ? undefined : content);
	};

	const server = createServer((req, res) => {
		void (async () => {
			try {
				if (!allow(req.socket.remoteAddress)) throw new HttpError(403, "forbidden");
				const url = req.url ?? "/";
				const pathname = new URL(url, "http://localhost").pathname;
				if (pathname === "/events" || pathname.startsWith("/api/")) {
					if (!isAuthorized(req.headers, url, token)) throw new HttpError(401, "unauthorized");
					if (pathname === "/events") {
						if (req.method !== "GET") throw new HttpError(405, "method not allowed");
						openStream(req, res);
						return;
					}
					await handleApi(req, res, pathname);
					return;
				}
				await serveStatic(req, res, pathname);
			} catch (error) {
				if (res.headersSent) {
					res.destroy();
					return;
				}
				if (error instanceof HttpError) {
					sendJson(res, error.status, { error: error.code ?? error.message, message: error.message });
					return;
				}
				sendJson(res, 500, { error: "internal error" });
			}
		})();
	});

	return {
		server,
		close() {
			unsubscribeHub();
			for (const client of clients.values()) {
				clearInterval(client.heartbeat);
				client.res.end();
			}
			clients.clear();
			server.close();
			server.closeAllConnections();
		},
	};
}
