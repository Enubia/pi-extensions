export function upsertEntry(entries, entry, cap) {
	const index = entries.findIndex((existing) => existing.id === entry.id);
	const next = index >= 0 ? entries.map((existing, i) => (i === index ? entry : existing)) : [...entries, entry];
	return next.length > cap ? next.slice(next.length - cap) : next;
}

export function appendDelta(entries, id, delta) {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index < 0) return entries;
	return entries.map((entry, i) => (i === index ? { ...entry, text: `${entry.text ?? ""}${delta}` } : entry));
}

export function mergeOlder(entries, older) {
	const known = new Set(entries.map((entry) => entry.id));
	return [...older.filter((entry) => !known.has(entry.id)), ...entries];
}

export function applySnapshot(entries, snapshot, cap) {
	const ids = new Set(snapshot.map((entry) => entry.id));
	const merged = [...snapshot, ...entries.filter((entry) => !ids.has(entry.id))];
	return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
