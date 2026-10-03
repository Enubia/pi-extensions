import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcTransport, LspError } from "../../extensions/lsp/transport.ts";

const FAKE_SERVER = `
const enc = (m) => { const b = JSON.stringify(m); return "Content-Length: " + Buffer.byteLength(b) + "\\r\\n\\r\\n" + b; };
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (;;) {
    const i = buf.indexOf("\\r\\n\\r\\n");
    if (i < 0) return;
    const len = +/Content-Length: (\\d+)/.exec(buf.slice(0, i))[1];
    if (Buffer.byteLength(buf) < i + 4 + len) return;
    const body = Buffer.from(buf).subarray(i + 4, i + 4 + len).toString();
    buf = Buffer.from(buf).subarray(i + 4 + len).toString();
    const m = JSON.parse(body);
    if (m.method === "echo") process.stdout.write(enc({ jsonrpc: "2.0", id: m.id, result: m.params }));
    if (m.method === "ask") {
      process.stdout.write(enc({ jsonrpc: "2.0", id: "s1", method: "client/known", params: {} }));
      process.stdout.write(enc({ jsonrpc: "2.0", id: "s2", method: "client/unknown", params: {} }));
    }
    if (m.id === "s1" || m.id === "s2") process.stdout.write(enc({ jsonrpc: "2.0", method: "gotReply", params: { id: m.id, result: m.result, error: m.error } }));
    if (m.method === "die") process.exit(3);
    if (m.method === "shutdown") process.stdout.write(enc({ jsonrpc: "2.0", id: m.id, result: null }));
    if (m.method === "exit") process.exit(0);
  }
});
`;

function fake(): JsonRpcTransport {
	return new JsonRpcTransport({ command: process.execPath, args: ["-e", FAKE_SERVER], cwd: process.cwd(), requestTimeoutMs: 2_000 });
}

test("request/response roundtrip and per-call timeout override", async () => {
	const t = fake();
	assert.deepEqual(await t.request("echo", { a: 1 }), { a: 1 });
	await assert.rejects(t.request("never", null, undefined, 50), (e: unknown) => e instanceof LspError && /timed out/.test(e.message));
	await t.dispose();
});

test("server requests: async handlers are awaited, unknown methods get MethodNotFound", async () => {
	const t = fake();
	t.onRequest("client/known", async () => {
		await new Promise((r) => setTimeout(r, 10));
		return { ok: true };
	});
	const replies: unknown[] = [];
	const done = new Promise<void>((resolve) => {
		t.onNotification("gotReply", (p) => {
			replies.push(p);
			if (replies.length === 2) resolve();
		});
	});
	t.notify("ask");
	await done;
	const byId = Object.fromEntries((replies as { id: string; result?: unknown; error?: { code: number } }[]).map((r) => [r.id, r]));
	assert.deepEqual(byId.s1, { id: "s1", result: { ok: true } });
	assert.ok(byId.s2.error);
	assert.equal(byId.s2.error.code, -32601);
	await t.dispose();
});

test("already-aborted signal rejects immediately; pending requests reject on server exit", async () => {
	const t = fake();
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(t.request("echo", 1, ac.signal), /aborted/);
	const pending = t.request("never");
	t.notify("die");
	await assert.rejects(pending, /exited/);
	assert.equal(t.isClosed, true);
	t.notify("after-exit");
	await t.dispose();
	await t.dispose();
});
