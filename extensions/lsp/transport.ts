import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { type JsonRpcId, type JsonRpcMessage, MessageDecoder, encodeMessage, isNotification, isRequest, isResponse } from "./protocol.ts";

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface TransportOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
	onStderr?: (text: string) => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class LspError extends Error {
	readonly code?: number;
	readonly data?: unknown;

	constructor(message: string, code?: number, data?: unknown) {
		super(message);
		this.name = "LspError";
		this.code = code;
		this.data = data;
	}
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

export class JsonRpcTransport {
	private readonly process: ChildProcess;
	private readonly decoder = new MessageDecoder();
	private readonly pending = new Map<JsonRpcId, Pending>();
	private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
	private readonly requestHandlers = new Map<string, ServerRequestHandler>();
	private readonly defaultTimeoutMs: number;
	private nextId = 1;
	private closed = false;
	private disposing?: Promise<void>;

	constructor(options: TransportOptions) {
		this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.process = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process.stdin?.on("error", () => {
			this.closed = true;
		});
		this.process.stdout?.on("data", (chunk: Buffer) => {
			for (const message of this.decoder.push(chunk)) this.dispatch(message);
		});
		this.process.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
		this.process.on("exit", (code, signal) => {
			this.closed = true;
			this.rejectAll(new LspError(`language server exited (code=${code}, signal=${signal})`));
			options.onExit?.(code, signal);
		});
		this.process.on("error", (error) => {
			this.closed = true;
			this.rejectAll(new LspError(`failed to spawn language server: ${error.message}`));
		});
	}

	get pid(): number | undefined {
		return this.process.pid;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	onNotification(method: string, handler: NotificationHandler): void {
		const list = this.notificationHandlers.get(method) ?? [];
		list.push(handler);
		this.notificationHandlers.set(method, list);
	}

	onRequest(method: string, handler: ServerRequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal, timeoutMs = this.defaultTimeoutMs): Promise<T> {
		if (this.closed) return Promise.reject(new LspError("transport closed"));
		if (signal?.aborted) return Promise.reject(new LspError(`${method} aborted`));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(new LspError(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onAbort = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				this.notify("$/cancelRequest", { id });
				reject(new LspError(`${method} aborted`));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value as T);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", method, params });
	}

	dispose(): Promise<void> {
		this.disposing ??= this.shutdown();
		return this.disposing;
	}

	private async shutdown(): Promise<void> {
		if (this.closed) return;
		const grace = sleep(2_000);
		await Promise.race([this.request("shutdown", null, undefined, 2_000).catch(() => undefined), grace.promise]);
		grace.cancel();
		this.notify("exit");
		const exited = new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
		const wait = sleep(2_000);
		await Promise.race([exited, wait.promise]);
		wait.cancel();
		if (!this.closed) this.process.kill("SIGKILL");
		this.closed = true;
	}

	private write(message: JsonRpcMessage): void {
		const stdin = this.process.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return;
		stdin.write(encodeMessage(message));
	}

	private dispatch(message: JsonRpcMessage): void {
		if (isResponse(message)) {
			if (message.id === null) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new LspError(message.error.message, message.error.code, message.error.data));
			else pending.resolve(message.result);
			return;
		}
		if (isRequest(message)) {
			void this.answer(message.id, message.method, message.params);
			return;
		}
		if (isNotification(message)) {
			for (const handler of this.notificationHandlers.get(message.method) ?? []) handler(message.params);
		}
	}

	private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Unhandled server request: ${method}` } });
			return;
		}
		try {
			const result = (await handler(params)) ?? null;
			this.write({ jsonrpc: "2.0", id, result });
		} catch (error) {
			this.write({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } });
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
