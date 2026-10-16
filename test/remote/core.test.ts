import assert from "node:assert/strict";
import test from "node:test";
import { condenseEntries, createStateTracker, pageEntries, routeSend, summarizeToolCall, validateClientMessage } from "../../extensions/remote/core.ts";
import { PROTOCOL_VERSION } from "../../extensions/remote/protocol.ts";

const branch = [
	{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fix the bug", timestamp: 1000 } },
	{ type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01Z", thinkingLevel: "high" },
	{
		type: "message",
		id: "e3",
		parentId: "e2",
		timestamp: "2026-01-01T00:00:02Z",
		message: {
			role: "assistant",
			timestamp: 2000,
			content: [
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "Running tests" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts" } },
			],
		},
	},
	{ type: "message", id: "e4", parentId: "e3", timestamp: "t", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "OUTPUT-SECRET" }], timestamp: 2500 } },
	{ type: "message", id: "e5", parentId: "e4", timestamp: "t", message: { role: "toolResult", toolCallId: "c2", toolName: "read", isError: true, content: [{ type: "text", text: "boom" }], timestamp: 2600 } },
	{ type: "message", id: "e6", parentId: "e5", timestamp: "t", message: { role: "user", timestamp: 3000, content: [{ type: "text", text: "look" }, { type: "image", data: "xx", mimeType: "image/png" }] } },
	{ type: "message", id: "e7", parentId: "e6", timestamp: "t", message: { role: "assistant", timestamp: 4000, content: [{ type: "thinking", thinking: "only thoughts" }] } },
	{ type: "message", id: "e8", parentId: "e7", timestamp: "t", message: { role: "assistant", timestamp: 5000, content: [{ type: "toolCall", id: "c3", name: "edit", arguments: {} }] } },
] as never[];

test("condenses user text, assistant text, tool calls; drops thinking, output, images", () => {
	const entries = condenseEntries(branch, new Map([["c1", 3200]]));
	assert.deepEqual(entries.map((entry) => entry.id), ["u:1000", "a:2000", "t:c1", "t:c2", "u:3000", "t:c3"]);
	assert.deepEqual(entries[0], { id: "u:1000", kind: "user", text: "fix the bug", timestamp: 1000 });
	assert.deepEqual(entries[1], { id: "a:2000", kind: "assistant", text: "Running tests", timestamp: 2000 });
	assert.deepEqual(entries[2], { id: "t:c1", kind: "tool", toolCallId: "c1", name: "bash", summary: "bash: npm test", args: { command: "npm test" }, status: "ok", durationMs: 3200, timestamp: 2000 });
	assert.equal((entries[3] as { status: string }).status, "error");
	assert.equal(entries[4].kind === "user" && entries[4].text, "look");
	assert.equal((entries[5] as { status: string }).status, "running");
	assert.ok(!JSON.stringify(entries).includes("OUTPUT-SECRET"));
	assert.ok(!JSON.stringify(entries).includes("secret"));
});

test("summarizeToolCall prefers well-known args and truncates", () => {
	assert.equal(summarizeToolCall("bash", { command: "ls   -la\nfoo" }), "bash: ls -la foo");
	assert.equal(summarizeToolCall("read", { path: "a.ts" }), "read: a.ts");
	assert.equal(summarizeToolCall("grep", { pattern: "x", path: "y" }), "grep: x");
	assert.equal(summarizeToolCall("custom", { other: 5 }), 'custom: {"other":5}');
	assert.equal(summarizeToolCall("edit", {}), "edit");
	assert.equal(summarizeToolCall("bash", { command: "x".repeat(200) }).length, 6 + 80);
});

test("pageEntries returns the newest limit entries, then pages back by id", () => {
	const entries = Array.from({ length: 120 }, (_, index) => ({ id: `u:${index}`, kind: "user" as const, text: String(index), timestamp: index }));
	const first = pageEntries(entries, undefined, 50);
	assert.equal(first.entries.length, 50);
	assert.equal(first.entries[0].id, "u:70");
	assert.equal(first.entries.at(-1)?.id, "u:119");
	assert.equal(first.hasMore, true);
	const second = pageEntries(entries, "u:70", 50);
	assert.equal(second.entries[0].id, "u:20");
	assert.equal(second.entries.at(-1)?.id, "u:69");
	assert.equal(second.hasMore, true);
	const third = pageEntries(entries, "u:20", 50);
	assert.equal(third.entries.length, 20);
	assert.equal(third.hasMore, false);
	assert.deepEqual(pageEntries(entries, "missing", 5), { entries: [], hasMore: false });
	assert.equal(pageEntries(entries, undefined, undefined).entries.length, 50);
});

test("routeSend: busy steers, idle prompts, followUp queues only when busy", () => {
	assert.deepEqual(routeSend(false, "auto"), { deliverAs: "steer" });
	assert.deepEqual(routeSend(false, "followUp"), { deliverAs: "followUp" });
	assert.deepEqual(routeSend(true, "auto"), {});
	assert.deepEqual(routeSend(true, "followUp"), {});
});

test("state tracker transitions with input > tui-dialog > busy > idle precedence", () => {
	const tracker = createStateTracker();
	assert.equal(tracker.state(), "idle");
	tracker.agentStart();
	assert.equal(tracker.state(), "busy");
	tracker.dialogStart();
	assert.equal(tracker.state(), "tui-dialog");
	tracker.questionStart("q1");
	assert.equal(tracker.state(), "input");
	tracker.questionEnd("q1");
	assert.equal(tracker.state(), "tui-dialog");
	tracker.dialogEnd();
	assert.equal(tracker.state(), "busy");
	tracker.agentSettled();
	assert.equal(tracker.state(), "idle");
	tracker.dialogEnd();
	assert.equal(tracker.state(), "idle");
	tracker.questionStart("q2");
	tracker.agentSettled();
	assert.equal(tracker.state(), "input");
});

test("validateClientMessage checks version, shape", () => {
	assert.deepEqual(validateClientMessage({ v: PROTOCOL_VERSION, type: "abort", id: "1" }), { ok: true, message: { v: PROTOCOL_VERSION, type: "abort", id: "1" } });
	assert.deepEqual(validateClientMessage({ v: 99, type: "abort", id: "1" }), { ok: false, id: "1", code: "incompatible", message: "unsupported protocol version 99" });
	assert.equal(validateClientMessage({ v: 1, type: "nope", id: "1" }).ok, false);
	assert.equal(validateClientMessage({ v: 1, type: "send", id: "1", text: "", mode: "auto" }).ok, false);
	assert.equal(validateClientMessage({ v: 1, type: "send", id: "1", text: "hi", mode: "weird" }).ok, false);
	assert.equal(validateClientMessage({ v: 1, type: "send", id: "1", text: "hi", mode: "auto" }).ok, true);
	assert.equal(validateClientMessage("str").ok, false);
	assert.equal(validateClientMessage({ v: 1, type: "snapshot", id: "1", limit: "x" }).ok, false);
	assert.equal(validateClientMessage({ v: 1, type: "snapshot", id: "1" }).ok, true);
});
