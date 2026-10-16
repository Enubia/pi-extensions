import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, orderSessions } from "../../apps/pi-remote/web/sessions.js";

const s = (pid: number, extra: Record<string, unknown> = {}) => ({ pid, label: `l${pid}`, state: "idle", lastActivity: 0, incompatible: false, ...extra });

test("sorts input, busy, tui-dialog, idle, then recency", () => {
	const rows = orderSessions([
		s(1, { state: "idle", lastActivity: 5 }),
		s(2, { state: "busy", lastActivity: 1 }),
		s(3, { state: "input", lastActivity: 1 }),
		s(4, { state: "idle", lastActivity: 9 }),
		s(5, { state: "tui-dialog", lastActivity: 1 }),
	]);
	assert.deepEqual(rows.map((r: { session: { pid: number } }) => r.session.pid), [3, 2, 5, 4, 1]);
});

test("incompatible sessions sort last", () => {
	const rows = orderSessions([s(1, { incompatible: true, state: "input" }), s(2)]);
	assert.deepEqual(rows.map((r: { session: { pid: number } }) => r.session.pid), [2, 1]);
});

test("nests children under parent by parentSession, group ranked by most urgent member", () => {
	const rows = orderSessions([
		s(1, { sessionId: "A", state: "idle" }),
		s(2, { sessionId: "B", parentSession: "A", state: "idle", lastActivity: 1 }),
		s(3, { sessionId: "C", parentSession: "A", state: "input" }),
		s(4, { sessionId: "D", state: "busy" }),
	]);
	assert.deepEqual(rows.map((r: { session: { pid: number }; depth: number }) => [r.session.pid, r.depth]), [[1, 0], [3, 1], [2, 1], [4, 0]]);
});

test("parent urgency bubbles up from children", () => {
	const rows = orderSessions([
		s(1, { sessionId: "A", state: "idle" }),
		s(2, { sessionId: "B", state: "busy" }),
		s(3, { sessionId: "C", parentSession: "A", state: "input" }),
	]);
	assert.deepEqual(rows.map((r: { session: { pid: number } }) => r.session.pid), [1, 3, 2]);
});

test("unknown parent stays flat", () => {
	const rows = orderSessions([s(1, { sessionId: "A", parentSession: "gone" })]);
	assert.deepEqual(rows.map((r: { depth: number }) => r.depth), [0]);
});

test("parent cycles do not drop sessions", () => {
	const rows = orderSessions([s(1, { sessionId: "A", parentSession: "B" }), s(2, { sessionId: "B", parentSession: "A" })]);
	assert.equal(rows.length, 2);
});

test("formats age", () => {
	assert.equal(formatAge(10_000, 10_500), "now");
	assert.equal(formatAge(0, 45_000), "45s");
	assert.equal(formatAge(0, 5 * 60_000), "5m");
	assert.equal(formatAge(0, 3 * 3600_000), "3h");
	assert.equal(formatAge(0, 49 * 3600_000), "2d");
	assert.equal(formatAge(undefined, 1000), "");
});
