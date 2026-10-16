import assert from "node:assert/strict";
import { test } from "node:test";
import { needsInputCount, shouldChime, titleFor } from "../../apps/pi-remote/web/alerts.js";

const s = (pid: number, state: string, extra: Record<string, unknown> = {}) => ({ pid, state, label: "x", lastActivity: 0, incompatible: false, ...extra });

test("no chime on first list", () => {
	assert.equal(shouldChime(null, [s(1, "input")]), false);
});

test("chimes when any session enters input", () => {
	assert.equal(shouldChime([s(1, "busy", { subagentId: "z" })], [s(1, "input", { subagentId: "z" })]), true);
});

test("chimes for a new session already in input after first list", () => {
	assert.equal(shouldChime([], [s(1, "input")]), true);
});

test("no chime while staying in input", () => {
	assert.equal(shouldChime([s(1, "input")], [s(1, "input")]), false);
});

test("chimes on main busy to idle", () => {
	assert.equal(shouldChime([s(1, "busy")], [s(1, "idle")]), true);
});

test("no chime for subagent busy to idle", () => {
	assert.equal(shouldChime([s(1, "busy", { subagentId: "a" })], [s(1, "idle", { subagentId: "a" })]), false);
	assert.equal(shouldChime([s(1, "busy", { parentSession: "p" })], [s(1, "idle", { parentSession: "p" })]), false);
});

test("no chime for idle to busy or removal", () => {
	assert.equal(shouldChime([s(1, "idle")], [s(1, "busy")]), false);
	assert.equal(shouldChime([s(1, "busy")], []), false);
});

test("incompatible sessions never chime", () => {
	assert.equal(shouldChime([s(1, "busy")], [s(1, "input", { incompatible: true })]), false);
});

test("title counts sessions needing input", () => {
	const list = [s(1, "input"), s(2, "busy"), s(3, "input")];
	assert.equal(needsInputCount(list), 2);
	assert.equal(titleFor(list), "(2) needs input");
	assert.equal(titleFor([s(1, "idle")]), "pi-remote");
});
