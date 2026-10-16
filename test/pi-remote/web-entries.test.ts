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

test("delta appends to the entry text; unknown id ignored", () => {
	const list = [e("a", "hel")];
	assert.equal(appendDelta(list, "a", "lo")[0].text, "hello");
	assert.deepEqual(appendDelta(list, "zzz", "x"), list);
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
