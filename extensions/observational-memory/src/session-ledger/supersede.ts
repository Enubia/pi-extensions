import type { Reflection } from "./types.js";

export function supersededReflectionIds(reflections: readonly Reflection[]): Map<string, string> {
	const known = new Set(reflections.map((reflection) => reflection.id));
	const supersededBy = new Map<string, string>();
	for (const reflection of reflections) {
		for (const id of reflection.supersedesReflectionIds ?? []) {
			if (id === reflection.id || !known.has(id) || supersededBy.has(id)) continue;
			supersededBy.set(id, reflection.id);
		}
	}
	return supersededBy;
}
