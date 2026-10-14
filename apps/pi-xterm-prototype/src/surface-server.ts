import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export type SurfaceHandlers = {
	create(request: { name: string; parent?: string; cwd?: string }): string;
	send(request: { surface: string; text: string }): boolean;
	read(request: { surface: string; lines: number }): Promise<string | undefined>;
	close(request: { surface: string }): boolean;
	rename(request: { surface: string; title: string }): boolean;
};

export type SurfaceServer = { socket: string; dispose(): void };

class NotFound extends Error {}

async function dispatch(handlers: SurfaceHandlers, op: string, body: Record<string, unknown>): Promise<unknown> {
	const surface = String(body.surface ?? "");
	const found = (ok: boolean) => {
		if (!ok) throw new NotFound(surface);
		return {};
	};
	switch (op) {
		case "create":
			return { surface: handlers.create({ name: String(body.name ?? "subagent"), parent: body.parent ? String(body.parent) : undefined, cwd: body.cwd ? String(body.cwd) : undefined }) };
		case "send":
			return found(handlers.send({ surface, text: String(body.text ?? "") }));
		case "read": {
			const text = await handlers.read({ surface, lines: Number(body.lines) || 50 });
			if (text === undefined) throw new NotFound(surface);
			return { text };
		}
		case "close":
			return found(handlers.close({ surface }));
		case "rename":
			return found(handlers.rename({ surface, title: String(body.title ?? "") }));
		default:
			throw new NotFound(op);
	}
}

export function startSurfaceServer(handlers: SurfaceHandlers): SurfaceServer {
	const socket = path.join(os.tmpdir(), `pi-xterm-${process.pid}.sock`);
	fs.rmSync(socket, { force: true });
	const server = http.createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			const op = (request.url ?? "").replace(/^\//, "");
			Promise.resolve()
				.then(() => dispatch(handlers, op, raw ? (JSON.parse(raw) as Record<string, unknown>) : {}))
				.then((result) => {
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify(result));
				})
				.catch((error: Error) => {
					response.statusCode = error instanceof NotFound ? 404 : 500;
					response.end(JSON.stringify({ error: error.message }));
				});
		});
	});
	server.listen(socket);
	return {
		socket,
		dispose: () => {
			server.close();
			fs.rmSync(socket, { force: true });
		},
	};
}
