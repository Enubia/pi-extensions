import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import remoteExtension from "../../extensions/remote/index.ts";
import { PROTOCOL_VERSION } from "../../extensions/remote/protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness(options: { mode?: string; idle?: boolean; branch?: unknown[]; name?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[][] = [];
	let aborted = 0;
	const state = { idle: options.idle ?? true, name: options.name };
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getSessionName: () => state.name,
		sendUserMessage(...args: unknown[]) {
			sent.push(args);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/work/my-project",
		isIdle: () => state.idle,
		abort: () => {
			aborted++;
		},
		sessionManager: { getSessionId: () => "sess-1", getBranch: () => options.branch ?? [] },
	};
	remoteExtension(pi);
	return {
		ctx,
		state,
		sent,
		aborted: () => aborted,
		handlerCount: () => [...handlers.values()].flat().length,
		async emit(event: string, payload: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
		},
	};
}

class Client {
	socket: Socket;
	messages: Record<string, unknown>[] = [];
	private buffer = "";
	private waiters: (() => void)[] = [];
	constructor(path: string) {
		this.socket = connect(path);
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) this.messages.push(JSON.parse(line));
			for (const waiter of this.waiters.splice(0)) waiter();
		});
	}
	send(message: Record<string, unknown>) {
		this.socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...message })}\n`);
	}
	sendRaw(text: string) {
		this.socket.write(text);
	}
	async next(predicate: (message: Record<string, unknown>) => boolean, from = 0): Promise<Record<string, unknown>> {
		const deadline = Date.now() + 3000;
		for (;;) {
			const found = this.messages.slice(from).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`timeout; got ${JSON.stringify(this.messages)}`);
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	}
	close() {
		this.socket.destroy();
	}
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-test-"));
	const previous = process.env.PI_REMOTE_DIR;
	process.env.PI_REMOTE_DIR = join(dir, "remote");
	try {
		return await run(join(dir, "remote"));
	} finally {
		if (previous === undefined) delete process.env.PI_REMOTE_DIR;
		else process.env.PI_REMOTE_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

const socketPath = (dir: string) => join(dir, `${process.pid}.sock`);

const STOP = "session_" + "shutdown";

test("factory registers handlers only and opens nothing until session_start", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		assert.ok(harness.handlerCount() > 0);
		assert.equal(existsSync(dir), false);
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(socketPath(dir)), true);
		await harness.emit(STOP);
	});
});

test("non-tui modes never open a socket", async () => {
	await withDir(async (dir) => {
		const harness = createHarness({ mode: "rpc" });
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(dir), false);
		await harness.emit(STOP);
	});
});

test("socket perms 0600, dir 0700; stop unlinks and is idempotent", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(statSync(socketPath(dir)).mode & 0o777, 0o600);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		await harness.emit(STOP);
		assert.equal(existsSync(socketPath(dir)), false);
		await harness.emit(STOP);
	});
});

test("hello carries identity, subagent env, label, state", async () => {
	await withDir(async (dir) => {
		process.env.PI_SUBAGENT_ID = "sub-9";
		process.env.PI_SUBAGENT_PARENT_SESSION = "parent-1";
		const harness = createHarness();
		try {
			await harness.emit("session_start", { reason: "startup" });
			const client = new Client(socketPath(dir));
			const hello = await client.next((message) => message.type === "hello");
			assert.equal(hello.v, PROTOCOL_VERSION);
			assert.equal(hello.pid, process.pid);
			assert.equal(hello.sessionId, "sess-1");
			assert.equal(hello.label, "my-project");
			assert.equal(hello.cwd, "/work/my-project");
			assert.equal(hello.state, "idle");
			assert.equal(hello.subagentId, "sub-9");
			assert.equal(hello.parentSession, "parent-1");
			assert.equal(typeof hello.lastActivity, "number");
			client.close();
		} finally {
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_SUBAGENT_PARENT_SESSION;
			await harness.emit(STOP);
		}
	});
});

test("state and label updates are pushed to all connected clients", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		const a = new Client(socketPath(dir));
		const b = new Client(socketPath(dir));
		await a.next((m) => m.type === "hello");
		await b.next((m) => m.type === "hello");
		await harness.emit("agent_start");
		for (const client of [a, b]) assert.equal((await client.next((m) => m.type === "state")).state, "busy");
		await harness.emit("tool_execution_start", { toolCallId: "q1", toolName: "ask_user_question", args: {} });
		await a.next((m) => m.type === "state" && m.state === "input");
		await harness.emit("tool_execution_end", { toolCallId: "q1", toolName: "ask_user_question", isError: false });
		await a.next((m) => m.type === "state" && m.state === "busy", a.messages.findIndex((m) => m.state === "input"));
		await harness.emit("ui_prompt_start", { kind: "select" });
		await a.next((m) => m.type === "state" && m.state === "tui-dialog");
		await harness.emit("ui_prompt_end", { kind: "select" });
		await harness.emit("agent_settled", { aborted: false });
		const dialogAt = a.messages.findIndex((m) => m.state === "tui-dialog");
		await a.next((m) => m.type === "state" && m.state === "idle", dialogAt);
		harness.state.name = "release prep";
		await harness.emit("session_info_changed", { name: "release prep" });
		for (const client of [a, b]) assert.equal((await client.next((m) => m.type === "label")).label, "release prep");
		a.close();
		b.close();
		await harness.emit(STOP);
	});
});

test("snapshot returns condensed entries and pages with before", async () => {
	await withDir(async (dir) => {
		const branch = Array.from({ length: 7 }, (_, index) => ({ type: "message", id: `e${index}`, parentId: null, timestamp: "t", message: { role: "user", content: `m${index}`, timestamp: index + 1 } }));
		const harness = createHarness({ branch });
		await harness.emit("session_start", { reason: "startup" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		client.send({ type: "snapshot", id: "s1", limit: 3 });
		const first = await client.next((m) => m.id === "s1");
		assert.equal(first.type, "snapshot_result");
		assert.deepEqual((first.entries as { id: string }[]).map((entry) => entry.id), ["u:5", "u:6", "u:7"]);
		assert.equal(first.hasMore, true);
		client.send({ type: "snapshot", id: "s2", before: "u:5", limit: 3 });
		const second = await client.next((m) => m.id === "s2");
		assert.deepEqual((second.entries as { id: string }[]).map((entry) => entry.id), ["u:2", "u:3", "u:4"]);
		client.close();
		await harness.emit(STOP);
	});
});

test("live events: assistant text deltas and tool start/end with durations", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		await harness.emit("message_update", { message: { role: "assistant", timestamp: 77 }, assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
		await harness.emit("message_update", { message: { role: "assistant", timestamp: 77 }, assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
		const delta = await client.next((m) => m.type === "text_delta");
		assert.deepEqual({ id: delta.id, delta: delta.delta }, { id: "a:77", delta: "Hel" });
		assert.equal(client.messages.filter((m) => m.type === "text_delta").length, 1);
		await harness.emit("message_end", { message: { role: "assistant", timestamp: 77, content: [{ type: "text", text: "Hello" }] } });
		const finalText = await client.next((m) => m.type === "entry" && (m.entry as { id: string }).id === "a:77");
		assert.equal((finalText.entry as { text: string }).text, "Hello");
		await harness.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "npm test" } });
		const started = await client.next((m) => m.type === "entry" && (m.entry as { id: string }).id === "t:c1");
		assert.equal((started.entry as { status: string }).status, "running");
		assert.equal((started.entry as { summary: string }).summary, "bash: npm test");
		await harness.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: "SECRET", isError: false, durationMs: 3200 });
		const ended = await client.next((m) => m.type === "entry" && (m.entry as { status: string }).status === "ok");
		assert.equal((ended.entry as { durationMs: number }).durationMs, 3200);
		assert.ok(!JSON.stringify(client.messages).includes("SECRET"));
		await harness.emit("message_end", { message: { role: "user", timestamp: 90, content: "hi" } });
		await client.next((m) => m.type === "entry" && (m.entry as { id: string }).id === "u:90");
		client.close();
		await harness.emit(STOP);
	});
});

test("send routes to steer when busy, followUp on request, plain prompt when idle", async () => {
	await withDir(async (dir) => {
		const harness = createHarness({ idle: false });
		await harness.emit("session_start", { reason: "startup" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		client.send({ type: "send", id: "1", text: "go left", mode: "auto" });
		assert.equal((await client.next((m) => m.id === "1")).type, "ack");
		client.send({ type: "send", id: "2", text: "later", mode: "followUp" });
		await client.next((m) => m.id === "2");
		harness.state.idle = true;
		client.send({ type: "send", id: "3", text: "fresh", mode: "followUp" });
		await client.next((m) => m.id === "3");
		assert.deepEqual(harness.sent, [
			["go left", { deliverAs: "steer", expandPromptTemplates: true }],
			["later", { deliverAs: "followUp", expandPromptTemplates: true }],
			["fresh", { expandPromptTemplates: true }],
		]);
		client.close();
		await harness.emit(STOP);
	});
});

test("abort calls ctx.abort and acks; bad input gets errors; unknown v is incompatible", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		client.send({ type: "abort", id: "a1" });
		assert.equal((await client.next((m) => m.id === "a1")).type, "ack");
		assert.equal(harness.aborted(), 1);
		client.sendRaw(`${JSON.stringify({ v: 99, type: "abort", id: "x" })}\n`);
		const incompatible = await client.next((m) => m.id === "x");
		assert.deepEqual({ type: incompatible.type, code: incompatible.code }, { type: "error", code: "incompatible" });
		assert.equal(harness.aborted(), 1);
		client.sendRaw("not json\n");
		await client.next((m) => m.type === "error" && m.code === "bad_request");
		client.send({ type: "send", id: "e1", text: "", mode: "auto" });
		assert.equal((await client.next((m) => m.id === "e1")).type, "error");
		client.send({ type: "snapshot", id: "still-alive" });
		await client.next((m) => m.id === "still-alive");
		client.close();
		await harness.emit(STOP);
	});
});

test("session_start twice replaces the socket without leaking", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("session_start", { reason: "reload" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		client.close();
		await harness.emit(STOP);
		assert.equal(existsSync(socketPath(dir)), false);
	});
});

test("nested tool calls with parentToolCallId are not streamed live", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		const client = new Client(socketPath(dir));
		await client.next((m) => m.type === "hello");
		await harness.emit("tool_execution_start", { toolCallId: "n1", parentToolCallId: "p1", toolName: "bash", args: { command: "ls" } });
		await harness.emit("tool_execution_end", { toolCallId: "n1", parentToolCallId: "p1", toolName: "bash", isError: false, durationMs: 5 });
		await harness.emit("tool_execution_start", { toolCallId: "c2", toolName: "bash", args: { command: "pwd" } });
		await client.next((m) => m.type === "entry" && (m.entry as { id: string }).id === "t:c2");
		assert.equal(client.messages.some((m) => m.type === "entry" && (m.entry as { id: string }).id === "t:n1"), false);
		client.close();
		await harness.emit(STOP);
	});
});

test("session switch clears stale question and dialog state", async () => {
	await withDir(async (dir) => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("tool_execution_start", { toolCallId: "q1", toolName: "ask_user_question", args: {} });
		await harness.emit("ui_prompt_start", { kind: "select" });
		await harness.emit("session_start", { reason: "new" });
		const client = new Client(socketPath(dir));
		assert.equal((await client.next((m) => m.type === "hello")).state, "idle");
		client.close();
		await harness.emit(STOP);
	});
});
