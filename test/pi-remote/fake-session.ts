import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { encodeMessage, parseLine, PROTOCOL_VERSION, type ClientMessage, type HelloMessage, type ServerMessage } from "../../extensions/remote/protocol.ts";

export type FakeSession = {
	pid: number;
	path: string;
	received: ClientMessage[];
	send(message: ServerMessage): void;
	close(): Promise<void>;
};

export type FakeSessionOptions = {
	hello?: Partial<HelloMessage>;
	onRequest?(message: ClientMessage, reply: (message: ServerMessage) => void): void;
	noHello?: boolean;
};

export function helloFor(pid: number, overrides: Partial<HelloMessage> = {}): HelloMessage {
	return { v: PROTOCOL_VERSION, type: "hello", pid, sessionId: `session-${pid}`, label: `label-${pid}`, cwd: `/work/${pid}`, state: "idle", lastActivity: 1000, ...overrides };
}

export async function startFakeSession(dir: string, pid: number, options: FakeSessionOptions = {}): Promise<FakeSession> {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${pid}.sock`);
	const sockets = new Set<Socket>();
	const received: ClientMessage[] = [];
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		const reply = (message: ServerMessage) => socket.write(encodeMessage(message));
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = parseLine(line) as ClientMessage;
				received.push(message);
				options.onRequest?.(message, reply);
			}
		});
		if (!options.noHello) reply(helloFor(pid, options.hello));
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return {
		pid,
		path,
		received,
		send(message) {
			for (const socket of sockets) socket.write(encodeMessage(message));
		},
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
