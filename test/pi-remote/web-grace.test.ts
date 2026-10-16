import assert from "node:assert/strict";
import { test } from "node:test";
import { createGrace } from "../../apps/pi-remote/web/grace.js";

function harness() {
	const pending = new Map<number, () => void>();
	let next = 0;
	const log: string[] = [];
	const grace = createGrace(
		3000,
		() => log.push("end"),
		() => log.push("return"),
		{ set: (fn: () => void) => (pending.set(++next, fn), next), clear: (id: number) => void pending.delete(id) } as never,
	);
	return { grace, pending, log };
}

test("ends only after the grace elapses", () => {
	const { grace, pending, log } = harness();
	grace.update(false);
	grace.update(false);
	assert.equal(pending.size, 1);
	assert.deepEqual(log, []);
	for (const fn of pending.values()) fn();
	assert.deepEqual(log, ["end"]);
});

test("reappearing within the grace cancels the end and reports a return", () => {
	const { grace, pending, log } = harness();
	grace.update(false);
	grace.update(true);
	assert.equal(pending.size, 0);
	assert.deepEqual(log, ["return"]);
	grace.update(true);
	assert.deepEqual(log, ["return"]);
});

test("cancel drops a pending end", () => {
	const { grace, pending, log } = harness();
	grace.update(false);
	grace.cancel();
	assert.equal(pending.size, 0);
	assert.deepEqual(log, []);
});
