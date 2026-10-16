import assert from "node:assert/strict";
import { test } from "node:test";
import { appendDelta, applySnapshot, mergeOlder, upsertEntry } from "../../apps/pi-remote/web/entries.js";

const e = (id: string, text = id, timestamp = 1) => ({ id, kind: "assistant", text, timestamp });

test("upsert replaces by id keeping position, even if timestamp differs", () => {
	const list = [e("a"), e("b", "b", 2)];
	const next = upsertEntry(list, e("a", "new", 99), 300);
	assert.deepEqual(next.map((x: { id: string; text: string }) => [x.id, x.text]), [["a", "new"], ["b", "b"]]);
});

test("upsert appends new ids", () => {
	assert.deepEqual(upsertEntry([e("a")], e("b"), 300).map((x: { id: string }) => x.id), ["a", "b"]);
});

test("upsert caps to the last N", () => {
	let list: ReturnType<typeof e>[] = [];
	for (let i = 0; i < 5; i++) list = upsertEntry(list, e(String(i)), 3);
	assert.deepEqual(list.map((x) => x.id), ["2", "3", "4"]);
});

test("upsert does not mutate input", () => {
	const list = [e("a")];
	upsertEntry(list, e("b"), 300);
	assert.equal(list.length, 1);
});

test("delta appends to the entry text; unknown id creates a provisional assistant entry", () => {
	const list = [e("a", "hel")];
	assert.equal(appendDelta(list, "a", "lo")[0].text, "hello");
	const created = appendDelta(list, "zzz", "x");
	assert.equal(created.length, 2);
	assert.deepEqual({ ...created[1], timestamp: 0 }, { id: "zzz", kind: "assistant", text: "x", timestamp: 0 });
	assert.ok(Math.abs(created[1].timestamp - Date.now()) < 5000);
	assert.equal(appendDelta(created, "zzz", "y")[1].text, "xy");
});

test("provisional entry stays last through a snapshot and is replaced by the final entry", () => {
	const streaming = appendDelta([e("a", "a", 10)], "a:99", "hi");
	const merged = applySnapshot(streaming, [e("a", "a", 10), e("b", "b", 20)], 300);
	assert.deepEqual(merged.map((x: { id: string }) => x.id), ["a", "b", "a:99"]);
	const final = upsertEntry(merged, e("a:99", "hi there", 99), 300);
	assert.equal(final.at(-1)?.text, "hi there");
	assert.equal(final.length, 3);
});

test("mergeOlder prepends deduped entries without the cap", () => {
	const list = [e("c"), e("d")];
	const next = mergeOlder(list, [e("a"), e("b"), e("c", "dup")]);
	assert.deepEqual(next.map((x: { id: string; text: string }) => x.id), ["a", "b", "c", "d"]);
	assert.equal(next[2].text, "c");
});

test("snapshot merge keeps live entries that arrived first", () => {
	const live = [e("x", "live", 50)];
	const merged = mergeOlder(live, [e("w"), e("x", "snap", 10)]);
	assert.deepEqual(merged.map((x: { id: string; text: string }) => [x.id, x.text]), [["w", "w"], ["x", "live"]]);
});

test("applySnapshot refreshes known ids, keeps live-only entries after, caps", () => {
	const next = applySnapshot([e("a", "stale"), e("z", "live")], [e("a", "fresh"), e("b")], 300);
	assert.deepEqual(next.map((x: { id: string; text: string }) => [x.id, x.text]), [["a", "fresh"], ["b", "b"], ["z", "live"]]);
	assert.deepEqual(applySnapshot([], [e("1"), e("2"), e("3")], 2).map((x: { id: string }) => x.id), ["2", "3"]);
});

test("applySnapshot on reconnect keeps chronological order past the snapshot window", () => {
	const held = Array.from({ length: 60 }, (_, i) => e(String(i + 1), String(i + 1), i + 1));
	const snapshot = held.slice(10).map((x) => ({ ...x, text: "fresh" }));
	const next = applySnapshot(held, snapshot, 300);
	assert.deepEqual(next.map((x: { id: string }) => x.id), held.map((x) => x.id));
	assert.equal(next[9].text, "10");
	assert.equal(next[10].text, "fresh");
});

test("applySnapshot keeps live entries newer than the snapshot after it", () => {
	const held = [e("1", "1", 1), e("2", "2", 2), e("3", "3", 3), e("4", "live", 4)];
	const next = applySnapshot(held, [e("2", "s", 2), e("3", "s", 3)], 300);
	assert.deepEqual(next.map((x: { id: string }) => x.id), ["1", "2", "3", "4"]);
});
