import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { createHub } from "./hub.ts";
import { createHttpApp } from "./http.ts";
import { acquireLock } from "./lock.ts";

export const DEFAULT_PORT = 7317;

export type CliOptions = { port: number; forMs: number | undefined };

export type StartOptions = CliOptions & { dir: string };

export type StartDeps = {
	print(line: string): void;
	lanAddress(): string | undefined;
	localHostName(): string | undefined;
	renderQr(url: string, done: (qr: string) => void): void;
	spawnCaffeinate(pid: number): { kill(): void } | undefined;
	onExpire?(): void;
};

export type RunningHub = { port: number; token: string; stop(): Promise<void> };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text: string): number | undefined {
	if (/^\d+$/.test(text)) {
		const minutes = Number(text);
		return minutes > 0 ? minutes * 60_000 : undefined;
	}
	if (!/^(\d+[smh])+$/.test(text)) return undefined;
	let total = 0;
	for (const match of text.matchAll(/(\d+)([smh])/g)) total += Number(match[1]) * UNIT_MS[match[2]];
	return total > 0 ? total : undefined;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const { values } = parseArgs({ args: argv, options: { port: { type: "string" }, for: { type: "string" } }, strict: true });
	let port = DEFAULT_PORT;
	if (values.port !== undefined) {
		port = Number(values.port);
		if (!/^\d+$/.test(values.port) || port > 65535) throw new Error(`invalid --port: ${values.port}`);
	}
	let forMs: number | undefined;
	if (values.for !== undefined) {
		forMs = parseDuration(values.for);
		if (forMs === undefined) throw new Error(`invalid --for: ${values.for} (try 30m, 2h)`);
	}
	return { port, forMs };
}

export function remoteDirectory(): string {
	return process.env.PI_REMOTE_DIR || join(homedir(), ".pi", "agent", "remote");
}

function webRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "web");
}

function timestamp(): string {
	return new Date().toTimeString().slice(0, 8);
}

export async function startPiRemote(options: StartOptions, deps: StartDeps): Promise<RunningHub> {
	const lock = acquireLock(options.dir);
	const token = randomBytes(32).toString("base64url");
	const hub = createHub({ dir: options.dir });
	const app = createHttpApp({ hub, token, webRoot: webRoot(), audit: (line) => deps.print(`[${timestamp()}] ${line}`) });
	let caffeinate: { kill(): void } | undefined;
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;

	const stop = async () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		app.close();
		hub.stop();
		caffeinate?.kill();
		lock.release();
	};

	return await new Promise<RunningHub>((resolve, reject) => {
		const fail = (error: Error) => {
			void stop();
			reject(error);
		};
		app.server.once("error", (error: NodeJS.ErrnoException) => {
			fail(error.code === "EADDRINUSE" ? new Error(`port ${options.port} is already in use (use --port)`) : error);
		});
		app.server.listen(options.port, "0.0.0.0", () => {
			void (async () => {
				try {
					const address = app.server.address();
					const port = typeof address === "object" && address ? address.port : options.port;
					await hub.start();
					caffeinate = deps.spawnCaffeinate(process.pid);
					if (options.forMs !== undefined) timer = setTimeout(() => deps.onExpire?.(), options.forMs);
					const lan = deps.lanAddress() ?? "127.0.0.1";
					const lanUrl = `http://${lan}:${port}/#t=${token}`;
					const host = deps.localHostName();
					deps.renderQr(lanUrl, (qr) => {
						deps.print(qr);
						deps.print(lanUrl);
						if (host) deps.print(`http://${host}.local:${port}/#t=${token}`);
						deps.print("Ctrl+C to stop");
						resolve({ port, token, stop });
					});
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			})();
		});
	});
}

export function realDeps(onExpire: () => void): StartDeps {
	return {
		print: (line) => console.log(line),
		lanAddress() {
			for (const addresses of Object.values(networkInterfaces())) {
				for (const address of addresses ?? []) {
					if (address.family === "IPv4" && !address.internal) return address.address;
				}
			}
			return undefined;
		},
		localHostName() {
			try {
				const name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2000 }).trim();
				if (name) return name;
			} catch {}
			return hostname().replace(/\.local$/, "") || undefined;
		},
		renderQr: (url, done) => qrcode.generate(url, { small: true }, done),
		spawnCaffeinate(pid) {
			try {
				const child = spawn("caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
				child.on("error", () => {});
				return { kill: () => void child.kill() };
			} catch {
				return undefined;
			}
		},
		onExpire,
	};
}
