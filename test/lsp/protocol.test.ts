import assert from "node:assert/strict";
import test from "node:test";
import { MessageDecoder, encodeMessage, isNotification, isRequest, isResponse } from "../../extensions/lsp/protocol.ts";

test("encode produces Content-Length framing with byte length", () => {
	const buf = encodeMessage({ jsonrpc: "2.0", method: "x", params: { s: "é" } });
	const text = buf.toString("utf8");
	const body = JSON.stringify({ jsonrpc: "2.0", method: "x", params: { s: "é" } });
	assert.equal(text, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
});

test("decoder reassembles messages split across chunks and concatenated in one chunk", () => {
	const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: "a" });
	const b = encodeMessage({ jsonrpc: "2.0", method: "n", params: [1] });
	const all = Buffer.concat([a, b]);
	const decoder = new MessageDecoder();
	const out = [
		...decoder.push(all.subarray(0, 7)),
		...decoder.push(all.subarray(7, a.length + 3)),
		...decoder.push(all.subarray(a.length + 3)),
	];
	assert.equal(out.length, 2);
	assert.ok(isResponse(out[0]!));
	assert.ok(isNotification(out[1]!));
	assert.ok(!isRequest(out[1]!));
});

test("decoder tolerates extra headers", () => {
	const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "m" });
	const raw = Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`);
	const [msg] = new MessageDecoder().push(raw);
	assert.ok(msg && isRequest(msg));
});
