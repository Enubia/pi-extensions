import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createHub, type Hub } from "../../apps/pi-remote/hub.ts";
import { createHttpApp, type HttpApp } from "../../apps/pi-remote/http.ts";
import { PROTOCOL_VERSION } from "../../extensions/remote/protocol.ts";
import { startFakeSession, waitFor, type FakeSession } from "./fake-session.ts";

const TOKEN = "test-token";

let root: string;
let hub: Hub;
let app: HttpApp;
let base: string;
let sessions: FakeSession[];
let audit: string[];
let allow: boolean;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-remote-http-"));
	mkdirSync(join(root, "web", "sub"), { recursive: true });
	writeFileSync(join(root, "web", "index.html"), "<h1>home</h1>");
	writeFileSync(join(root, "web", "app.js"), "1");
	writeFileSync(join(root, "web", "app.css"), "a{}");
	writeFileSync(join(root, "web", "sub", "x.txt"), "x");
	writeFileSync(join(root, "secret.txt"), "top secret");
	sessions = [];
	audit = [];
	allow = true;
	hub = createHub({ dir: join(root, "sockets"), requestTimeoutMs: 500 });
	app = createHttpApp({ hub, token: TOKEN, webRoot: join(root, "web"), audit: (line) => audit.push(line), allowAddress: () => allow, heartbeatMs: 20 });
	await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
	await hub.start();
});

afterEach(async () => {
	app.close();
	hub.stop();
	await Promise.all(sessions.map((session) => session.close()));
	rmSync(root, { recursive: true, force: true });
});

async function session(pid: number, options?: Parameters<typeof startFakeSession>[2]): Promise<FakeSession> {
	const fake = await startFakeSession(join(root, "sockets"), pid, options);
	sessions.push(fake);
	await waitFor(() => hub.list().some((item) => item.pid === pid));
	return fake;
}

function post(path: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
}

type SseEvent = { event: string; data: unknown };

async function openStream(query = `?t=${TOKEN}`, headers: Record<string, string> = {}) {
	const controller = new AbortController();
	const response = await fetch(`${base}/events${query}`, { headers, signal: controller.signal });
	const received: SseEvent[] = [];
	const done = (async () => {
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk as Uint8Array, { stream: true });
				const blocks = buffer.split("\n\n");
				buffer = blocks.pop() ?? "";
				for (const block of blocks) {
					const event = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (event && data) received.push({ event, data: JSON.parse(data) });
				}
			}
		} catch {}
	})();
	return { response, received, close: () => controller.abort(), done };
}

test("serves static files with content types and no auth", async () => {
	const index = await fetch(`${base}/`);
	assert.equal(index.status, 200);
	assert.match(index.headers.get("content-type") ?? "", /text\/html/);
	assert.equal(await index.text(), "<h1>home</h1>");
	assert.match((await fetch(`${base}/app.js`)).headers.get("content-type") ?? "", /javascript/);
	assert.match((await fetch(`${base}/app.css`)).headers.get("content-type") ?? "", /text\/css/);
	assert.equal((await fetch(`${base}/missing.js`)).status, 404);
	assert.equal((await fetch(`${base}/sub`)).status, 404);
});

test("static serving is path-traversal safe", async () => {
	for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/sub/../../secret.txt", "/%00", "/%zz"]) {
		const response = await new Promise<number>((resolve, reject) => {
			import("node:http").then(({ request }) => {
				const url = new URL(base);
				request({ host: url.hostname, port: url.port, path, method: "GET" }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				}).on("error", reject).end();
			});
		});
		assert.ok(response === 404 || response === 400, `${path} -> ${response}`);
	}
});

test("rejects disallowed source addresses with 403 everywhere", async () => {
	allow = false;
	assert.equal((await fetch(`${base}/`)).status, 403);
	assert.equal((await fetch(`${base}/events?t=${TOKEN}`)).status, 403);
	assert.equal((await post("/api/sessions/1/abort", {})).status, 403);
});

test("requires a valid token for events and api", async () => {
	assert.equal((await fetch(`${base}/events`)).status, 401);
	assert.equal((await fetch(`${base}/events?t=bad`)).status, 401);
	assert.equal((await post("/api/sessions/1/abort", {}, "bad")).status, 401);
	assert.equal((await post("/api/sessions/1/abort", {}, null)).status, 401);
});

test("SSE sends ready, sessions snapshot and updates; accepts header token", async () => {
	const fake = await session(10, { hello: { label: "one" } });
	const stream = await openStream("", { authorization: `Bearer ${TOKEN}` });
	assert.match(stream.response.headers.get("content-type") ?? "", /text\/event-stream/);
	await waitFor(() => stream.received.some((item) => item.event === "sessions"));
	const ready = stream.received.find((item) => item.event === "ready")?.data as { clientId: string };
	assert.ok(ready.clientId);
	const first = stream.received.find((item) => item.event === "sessions")?.data as { sessions: { pid: number; label: string }[] };
	assert.equal(first.sessions[0].pid, 10);
	fake.send({ v: PROTOCOL_VERSION, type: "label", label: "two" });
	await waitFor(() => stream.received.some((item) => item.event === "sessions" && (item.data as { sessions: { label: string }[] }).sessions[0]?.label === "two"));
	stream.close();
	await stream.done;
});

test("entries only reach clients subscribed to that session", async () => {
	const fake = await session(11);
	const subscribed = await openStream();
	const other = await openStream();
	const ready = await waitFor(() => subscribed.received.find((item) => item.event === "ready")?.data as { clientId: string } | undefined);
	await waitFor(() => other.received.some((item) => item.event === "ready"));
	const response = await post("/api/subscribe", { clientId: ready.clientId, pids: [11] });
	assert.equal(response.status, 200);
	const entry = { id: "e1", kind: "assistant" as const, text: "hi", timestamp: 1 };
	fake.send({ v: PROTOCOL_VERSION, type: "entry", entry });
	fake.send({ v: PROTOCOL_VERSION, type: "text_delta", id: "e1", delta: "d" });
	await waitFor(() => subscribed.received.some((item) => item.event === "text_delta"));
	assert.deepEqual(subscribed.received.find((item) => item.event === "entry")?.data, { pid: 11, entry });
	assert.deepEqual(subscribed.received.find((item) => item.event === "text_delta")?.data, { pid: 11, id: "e1", delta: "d" });
	assert.equal(other.received.some((item) => item.event === "entry"), false);
	assert.equal((await post("/api/subscribe", { clientId: "nope", pids: [] })).status, 404);
	assert.equal((await post("/api/subscribe", { clientId: ready.clientId, pids: "x" })).status, 400);
	subscribed.close();
	other.close();
	await Promise.all([subscribed.done, other.done]);
});

test("SSE emits heartbeat comments and audits connect/disconnect", async () => {
	const stream = await openStream("?t=" + TOKEN, { "user-agent": "TestPhone/1" });
	await waitFor(() => audit.some((line) => line.includes("connected")));
	assert.match(audit.find((line) => line.includes("connected")) ?? "", /127\.0\.0\.1.*TestPhone\/1/);
	stream.close();
	await stream.done;
	await waitFor(() => audit.some((line) => line.includes("disconnected")));
});

test("snapshot request is relayed and result returned", async () => {
	const fake = await session(12, {
		onRequest: (message, reply) => {
			if (message.type === "snapshot") reply({ v: PROTOCOL_VERSION, type: "snapshot_result", id: message.id, entries: [{ id: "a", kind: "user", text: "q", timestamp: 1 }], hasMore: true });
		},
	});
	const response = await post("/api/sessions/12/snapshot", { before: "zz", limit: 5 });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { entries: [{ id: "a", kind: "user", text: "q", timestamp: 1 }], hasMore: true });
	const sent = fake.received[0] as { type: string; before?: string; limit?: number };
	assert.equal(sent.type, "snapshot");
	assert.equal(sent.before, "zz");
	assert.equal(sent.limit, 5);
});

test("send, abort and answer are relayed and audited", async () => {
	const fake = await session(13, {
		hello: { label: "worker", state: "busy" },
		onRequest: (message, reply) => reply({ v: PROTOCOL_VERSION, type: "ack", id: message.id }),
	});
	assert.equal((await post("/api/sessions/13/send", { text: "steer me", mode: "auto" })).status, 200);
	assert.equal((await post("/api/sessions/13/send", { text: "later", mode: "followUp" })).status, 200);
	assert.equal((await post("/api/sessions/13/abort", {})).status, 200);
	assert.equal((await post("/api/sessions/13/answer", { toolCallId: "t1", answers: [{ type: "option", index: 0 }] })).status, 200);
	assert.deepEqual(fake.received.map((message) => message.type), ["send", "send", "abort", "answer"]);
	assert.deepEqual(fake.received.map((message) => ("mode" in message ? message.mode : undefined)), ["auto", "followUp", undefined, undefined]);
	assert.deepEqual(audit.filter((line) => line.includes("→")).map((line) => line.replace(/^.*?(steer|prompt|followUp|answer|abort)/, "$1")), ["steer → worker", "followUp → worker", "abort → worker", "answer → worker"]);
});

test("auto send on an idle session is audited as prompt", async () => {
	await session(14, { hello: { label: "idler", state: "idle" }, onRequest: (message, reply) => reply({ v: PROTOCOL_VERSION, type: "ack", id: message.id }) });
	await post("/api/sessions/14/send", { text: "go", mode: "auto" });
	assert.match(audit.join("\n"), /prompt → idler/);
});

test("maps relay failures to http statuses", async () => {
	await session(15, {
		onRequest: (message, reply) => {
			if (message.type === "answer") reply({ v: PROTOCOL_VERSION, type: "error", id: message.id, code: "stale", message: "closed" });
			else if (message.type === "send") reply({ v: PROTOCOL_VERSION, type: "error", id: message.id, code: "bad_request", message: "text is required" });
		},
	});
	const stale = await post("/api/sessions/15/answer", { toolCallId: "t", answers: [{ type: "text", text: "x" }] });
	assert.equal(stale.status, 409);
	assert.equal(((await stale.json()) as { error: string }).error, "stale");
	assert.equal((await post("/api/sessions/15/send", { text: "x", mode: "auto" })).status, 400);
	assert.equal((await post("/api/sessions/15/abort", {})).status, 504);
	assert.equal((await post("/api/sessions/999/abort", {})).status, 404);
	assert.equal((await post("/api/sessions/abc/abort", {})).status, 404);
	assert.equal((await post("/api/sessions/15/nope", {})).status, 404);
	assert.equal((await post("/api/sessions/15/send", { mode: "auto" })).status, 400);
	assert.equal((await post("/api/sessions/15/send", { text: "x", mode: "weird" })).status, 400);
	assert.equal((await post("/api/sessions/15/answer", { toolCallId: "t" })).status, 400);
	const malformed = await fetch(`${base}/api/sessions/15/abort`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
	assert.equal(malformed.status, 400);
	assert.equal((await fetch(`${base}/api/sessions/15/abort`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test("incompatible sessions answer 409 incompatible", async () => {
	await session(16, { hello: { v: PROTOCOL_VERSION + 1 } });
	const response = await post("/api/sessions/16/abort", {});
	assert.equal(response.status, 409);
	assert.equal(((await response.json()) as { error: string }).error, "incompatible");
});

test("close ends open event streams", async () => {
	const stream = await openStream();
	await waitFor(() => stream.received.some((item) => item.event === "ready"));
	app.close();
	await stream.done;
});
