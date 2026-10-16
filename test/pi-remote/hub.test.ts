import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createHub, type Hub, type HubEvent } from "../../apps/pi-remote/hub.ts";
import { LOCK_FILE_NAME } from "../../apps/pi-remote/lock.ts";
import { PROTOCOL_VERSION } from "../../extensions/remote/protocol.ts";
import { startFakeSession, waitFor, type FakeSession } from "./fake-session.ts";

let dir: string;
let hub: Hub;
let sessions: FakeSession[];
let events: HubEvent[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-remote-hub-"));
	sessions = [];
	events = [];
	hub = createHub({ dir, requestTimeoutMs: 500 });
	hub.subscribe((event) => events.push(event));
});

afterEach(async () => {
	hub.stop();
	await Promise.all(sessions.map((session) => session.close()));
	rmSync(dir, { recursive: true, force: true });
});

async function session(pid: number, options?: Parameters<typeof startFakeSession>[2]): Promise<FakeSession> {
	const fake = await startFakeSession(dir, pid, options);
	sessions.push(fake);
	return fake;
}

test("discovers existing sockets and lists them", async () => {
	await session(111, { hello: { label: "alpha", state: "busy" } });
	await hub.start();
	const list = await waitFor(() => (hub.list().length === 1 ? hub.list() : undefined));
	assert.equal(list[0].pid, 111);
	assert.equal(list[0].label, "alpha");
	assert.equal(list[0].state, "busy");
	assert.equal(list[0].incompatible, false);
});

test("picks up sockets that appear later and drops closed ones", async () => {
	await hub.start();
	assert.deepEqual(hub.list(), []);
	const fake = await session(222);
	await waitFor(() => hub.list().length === 1);
	await fake.close();
	await waitFor(() => hub.list().length === 0);
});

test("unlinks sockets nobody listens on", async () => {
	const stale = join(dir, "333.sock");
	const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>console.log('up'))", stale], { stdio: ["ignore", "pipe", "ignore"] });
	try {
		await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		assert.equal(existsSync(stale), true);
		await hub.start();
		await waitFor(() => !existsSync(stale));
		assert.deepEqual(hub.list(), []);
	} finally {
		child.kill("SIGKILL");
	}
});

test("ignores the lock file and non-socket names", async () => {
	writeFileSync(join(dir, LOCK_FILE_NAME), `${process.pid}\n`);
	writeFileSync(join(dir, "notes.txt"), "x");
	writeFileSync(join(dir, "12.sock.bak"), "x");
	writeFileSync(join(dir, "abc.sock"), "x");
	await hub.start();
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(hub.list(), []);
	assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), true);
	assert.equal(existsSync(join(dir, "abc.sock")), true);
});

test("flags incompatible sessions but keeps them listed", async () => {
	await session(444, { hello: { v: PROTOCOL_VERSION + 1, label: "future" } });
	await hub.start();
	const list = await waitFor(() => (hub.list().length === 1 ? hub.list() : undefined));
	assert.equal(list[0].incompatible, true);
	assert.equal(list[0].label, "future");
	await assert.rejects(hub.request(444, { type: "abort" }), (error) => (error as { code?: string }).code === "incompatible");
});

test("flags a session answering with an incompatible error", async () => {
	await session(445, {
		onRequest: (message, reply) => reply({ v: PROTOCOL_VERSION, type: "error", id: message.id, code: "incompatible", message: "nope" }),
	});
	await hub.start();
	await waitFor(() => hub.list().length === 1);
	await assert.rejects(hub.request(445, { type: "abort" }), (error) => (error as { code?: string }).code === "incompatible");
	assert.equal(hub.list()[0].incompatible, true);
});

test("tracks state, label, question and nesting", async () => {
	const parent = await session(1, { hello: { sessionId: "parent-id" } });
	await session(2, { hello: { parentSession: "parent-id", subagentId: "sub" } });
	await hub.start();
	await waitFor(() => hub.list().length === 2);
	const child = hub.list().find((item) => item.pid === 2);
	assert.equal(child?.parentPid, 1);
	assert.equal(hub.list().find((item) => item.pid === 1)?.parentPid, undefined);

	parent.send({ v: PROTOCOL_VERSION, type: "state", state: "input", lastActivity: 5000 });
	parent.send({ v: PROTOCOL_VERSION, type: "label", label: "renamed" });
	parent.send({ v: PROTOCOL_VERSION, type: "question", toolCallId: "t1", question: "Which?", mode: "single-select", options: [{ label: "A", value: "a" }] });
	await waitFor(() => hub.list().find((item) => item.pid === 1)?.question);
	const view = hub.list().find((item) => item.pid === 1);
	assert.equal(view?.state, "input");
	assert.equal(view?.label, "renamed");
	assert.equal(view?.lastActivity, 5000);
	assert.equal(view?.question?.toolCallId, "t1");

	parent.send({ v: PROTOCOL_VERSION, type: "question_closed", toolCallId: "t1" });
	await waitFor(() => hub.list().find((item) => item.pid === 1)?.question === undefined);
});

test("forwards entries and text deltas with the pid", async () => {
	const fake = await session(5);
	await hub.start();
	await waitFor(() => hub.list().length === 1);
	const entry = { id: "e1", kind: "assistant" as const, text: "hi", timestamp: 1 };
	fake.send({ v: PROTOCOL_VERSION, type: "entry", entry });
	fake.send({ v: PROTOCOL_VERSION, type: "text_delta", id: "e1", delta: "x" });
	await waitFor(() => events.some((event) => event.type === "text_delta"));
	assert.deepEqual(events.find((event) => event.type === "entry"), { type: "entry", pid: 5, entry });
	assert.deepEqual(events.find((event) => event.type === "text_delta"), { type: "text_delta", pid: 5, id: "e1", delta: "x" });
});

test("relays requests and resolves on the matching reply", async () => {
	await session(6, {
		onRequest: (message, reply) => {
			if (message.type === "snapshot") reply({ v: PROTOCOL_VERSION, type: "snapshot_result", id: message.id, entries: [], hasMore: true });
			else reply({ v: PROTOCOL_VERSION, type: "ack", id: message.id });
		},
	});
	await hub.start();
	await waitFor(() => hub.list().length === 1);
	const snapshot = await hub.request(6, { type: "snapshot", limit: 10 });
	assert.equal(snapshot.type, "snapshot_result");
	const ack = await hub.request(6, { type: "send", text: "go", mode: "auto" });
	assert.equal(ack.type, "ack");
});

test("surfaces stale errors, unknown sessions and timeouts", async () => {
	await session(7, {
		onRequest: (message, reply) => {
			if (message.type === "answer") reply({ v: PROTOCOL_VERSION, type: "error", id: message.id, code: "stale", message: "closed" });
		},
	});
	await hub.start();
	await waitFor(() => hub.list().length === 1);
	await assert.rejects(hub.request(7, { type: "answer", toolCallId: "t", answers: [{ type: "text", text: "x" }] }), (error) => (error as { code?: string }).code === "stale");
	await assert.rejects(hub.request(999, { type: "abort" }), (error) => (error as { code?: string }).code === "unknown_session");
	await assert.rejects(hub.request(7, { type: "abort" }), (error) => (error as { code?: string }).code === "timeout");
});

test("emits sessions events on change and stop closes sockets", async () => {
	const fake = await session(8);
	await hub.start();
	await waitFor(() => events.some((event) => event.type === "sessions"));
	hub.stop();
	assert.deepEqual(hub.list(), []);
	await waitFor(() => fake.received.length === 0);
});
