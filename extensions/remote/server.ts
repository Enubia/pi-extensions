import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { encodeMessage, parseLine, type ServerMessage } from "./protocol.ts";

const MAX_LINE_LENGTH = 1_000_000;

export type RemoteClient = { send(message: ServerMessage): void };

export type SocketServerHandlers = {
	onConnect(client: RemoteClient): void;
	onLine(client: RemoteClient, value: unknown): void;
};

export type SocketServer = { broadcast(message: ServerMessage): void; close(): void };

export function startSocketServer(directory: string, pid: number, handlers: SocketServerHandlers): SocketServer | undefined {
	const path = join(directory, `${pid}.sock`);
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		try {
			unlinkSync(path);
		} catch {}
		server = createServer((socket) => {
			sockets.add(socket);
			socket.setEncoding("utf8");
			const client: RemoteClient = {
				send(message) {
					if (!socket.destroyed) socket.write(encodeMessage(message), () => {});
				},
			};
			let buffer = "";
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				if (buffer.length > MAX_LINE_LENGTH && !buffer.includes("\n")) {
					socket.destroy();
					return;
				}
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						handlers.onLine(client, parseLine(line));
					} catch {}
				}
			});
			try {
				handlers.onConnect(client);
			} catch {}
		});
		server.on("error", () => {});
		server.listen(path);
		try {
			chmodSync(path, 0o600);
		} catch {}
	} catch {
		return undefined;
	}
	const active = server;
	let closed = false;
	return {
		broadcast(message) {
			if (closed || sockets.size === 0) return;
			const line = encodeMessage(message);
			for (const socket of sockets) if (!socket.destroyed) socket.write(line, () => {});
		},
		close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			try {
				active.close();
			} catch {}
			try {
				unlinkSync(path);
			} catch {}
		},
	};
}
