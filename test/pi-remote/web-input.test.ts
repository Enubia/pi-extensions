import assert from "node:assert/strict";
import { test } from "node:test";
import { answersFor, composerFor, selectionIsValid } from "../../apps/pi-remote/web/input.js";

const q = (mode: string) => ({ toolCallId: "t", question: "?", mode, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] });

test("idle shows Send, busy shows Steer, both allow queue", () => {
	assert.deepEqual(composerFor({ state: "idle", incompatible: false }), { kind: "send", label: "Send", canQueue: true, placeholder: "Message", disabled: false });
	const busy = composerFor({ state: "busy", incompatible: false });
	assert.equal(busy.label, "Steer");
	assert.equal(busy.canQueue, true);
});

test("pending question routes the box as an answer", () => {
	const c = composerFor({ state: "input", incompatible: false, question: q("single-select") });
	assert.equal(c.kind, "answer");
	assert.equal(c.label, "Other");
	assert.equal(c.canQueue, false);
});

test("text question labels the box Answer", () => {
	assert.equal(composerFor({ state: "input", incompatible: false, question: q("text") }).label, "Answer");
});

test("tui-dialog disables input with notice", () => {
	const c = composerFor({ state: "tui-dialog", incompatible: false });
	assert.equal(c.disabled, true);
	assert.equal(c.notice, "waiting on a TUI dialog");
});

test("incompatible disables input", () => {
	const c = composerFor({ state: "idle", incompatible: true });
	assert.equal(c.disabled, true);
	assert.equal(c.notice, "incompatible, /reload");
});

test("input state without a question is plain busy-like send", () => {
	assert.equal(composerFor({ state: "input", incompatible: false }).kind, "send");
});

test("answers map options, other and text", () => {
	assert.deepEqual(answersFor(q("single-select"), { indexes: [1] }), [{ type: "option", index: 1 }]);
	assert.deepEqual(answersFor(q("multi-select"), { indexes: [0, 1], text: "extra" }), [{ type: "option", index: 0 }, { type: "option", index: 1 }, { type: "other", text: "extra" }]);
	assert.deepEqual(answersFor(q("single-select"), { text: "hm" }), [{ type: "other", text: "hm" }]);
	assert.deepEqual(answersFor(q("text"), { text: "yo" }), [{ type: "text", text: "yo" }]);
});

test("selection validity", () => {
	assert.equal(selectionIsValid(q("multi-select"), { indexes: [] }), false);
	assert.equal(selectionIsValid(q("multi-select"), { indexes: [0] }), true);
	assert.equal(selectionIsValid(q("text"), { text: "  " }), false);
	assert.equal(selectionIsValid(q("single-select"), { text: "x" }), true);
});
