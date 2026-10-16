import { mkdirSync, readdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { CondensedEntry } from "../../extensions/remote/protocol.ts";
import { connectSession, RequestError, type ReplyMessage, type RequestPayload, type SessionConnection, type SessionInfo } from "./connection.ts";

export { RequestError } from "./connection.ts";
export type { ReplyMessage, RequestPayload, SessionInfo, SessionQuestion } from "./connection.ts";

const SOCKET_NAME = /^(\d+)\.sock$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const RESCAN_DEBOUNCE_MS = 25;
const REFUSED_RETRY_MS = 150;
const POLL_INTERVAL_MS = 500;
const ACTIVITY_BROADCAST_MS = 1000;

export type HubEvent =
	| { type: "sessions" }
	| { type: "entry"; pid: number; entry: CondensedEntry }
	| { type: "text_delta"; pid: number; id: string; delta: string };

export type Hub = {
	start(): Promise<void>;
	stop(): void;
	list(): SessionInfo[];
	subscribe(listener: (event: HubEvent) => void): () => void;
	request(pid: number, payload: RequestPayload): Promise<ReplyMessage>;
};

export type HubOptions = { dir: string; requestTimeoutMs?: number };

export function createHub(options: HubOptions): Hub {
	const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const connections = new Map<number, SessionConnection>();
	const ready = new Set<number>();
	const refusedOnce = new Set<number>();
	const listeners = new Set<(event: HubEvent) => void>();
	let watcher: FSWatcher | undefined;
	let rescanTimer: NodeJS.Timeout | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let stopped = false;

	const emit = (event: HubEvent) => {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {}
		}
	};

	const lastBroadcast = new Map<number, number>();

	const touch = (pid: number) => {
		const connection = connections.get(pid);
		if (!connection) return;
		const now = Date.now();
		connection.info.lastActivity = now;
		if (now - (lastBroadcast.get(pid) ?? 0) < ACTIVITY_BROADCAST_MS) return;
		lastBroadcast.set(pid, now);
		emit({ type: "sessions" });
	};

	const connectTo = (pid: number) => {
		if (connections.has(pid) || stopped) return;
		const path = join(options.dir, `${pid}.sock`);
		const connection = connectSession(path, pid, {
			onReady() {
				ready.add(pid);
				refusedOnce.delete(pid);
				emit({ type: "sessions" });
			},
			onChange() {
				if (ready.has(pid)) emit({ type: "sessions" });
			},
			onEntry(entry) {
				if (!ready.has(pid)) return;
				touch(pid);
				emit({ type: "entry", pid, entry });
			},
			onTextDelta(id, delta) {
				if (!ready.has(pid)) return;
				touch(pid);
				emit({ type: "text_delta", pid, id, delta });
			},
			onClose(error) {
				if (connections.get(pid) === connection) connections.delete(pid);
				const wasReady = ready.delete(pid);
				lastBroadcast.delete(pid);
				if (error?.code === "ECONNREFUSED") {
					if (!refusedOnce.has(pid)) {
						refusedOnce.add(pid);
						setTimeout(() => connectTo(pid), REFUSED_RETRY_MS).unref();
					} else {
						refusedOnce.delete(pid);
						try {
							unlinkSync(path);
						} catch {}
					}
				}
				if (wasReady && !stopped) emit({ type: "sessions" });
			},
		});
		connections.set(pid, connection);
	};

	const scan = () => {
		if (stopped) return;
		let names: string[];
		try {
			names = readdirSync(options.dir);
		} catch {
			return;
		}
		for (const name of names) {
			const match = SOCKET_NAME.exec(name);
			if (!match) continue;
			const pid = Number(match[1]);
			if (!refusedOnce.has(pid)) connectTo(pid);
		}
	};

	const scheduleScan = () => {
		if (rescanTimer || stopped) return;
		rescanTimer = setTimeout(() => {
			rescanTimer = undefined;
			scan();
		}, RESCAN_DEBOUNCE_MS);
	};

	return {
		async start() {
			mkdirSync(options.dir, { recursive: true, mode: 0o700 });
			try {
				watcher = watch(options.dir, scheduleScan);
				watcher.on("error", () => {});
			} catch {}
			pollTimer = setInterval(scan, POLL_INTERVAL_MS);
			pollTimer.unref();
			scan();
		},
		stop() {
			stopped = true;
			if (rescanTimer) clearTimeout(rescanTimer);
			rescanTimer = undefined;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			watcher?.close();
			watcher = undefined;
			for (const connection of [...connections.values()]) connection.close();
			connections.clear();
			ready.clear();
			listeners.clear();
		},
		list() {
			return [...connections.values()].filter((connection) => ready.has(connection.info.pid)).map((connection) => connection.info);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		request(pid, payload) {
			const connection = connections.get(pid);
			if (!connection || !ready.has(pid)) return Promise.reject(new RequestError("unknown_session", `no session with pid ${pid}`));
			return connection.request(payload, timeoutMs);
		},
	};
}
