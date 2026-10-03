import {
	OM_COST,
	OM_ENABLED,
	OM_OBSERVATIONS_RECORDED,
	type CostEntryData,
	type Entry,
	type Observation,
} from "../../extensions/observational-memory/src/session-ledger/index.js";

let counter = 0;

export function nextId(prefix = "e"): string {
	counter += 1;
	return `${prefix}${counter.toString().padStart(4, "0")}`;
}

export function memoryId(seed: number): string {
	return seed.toString(16).padStart(12, "0");
}

export function userEntry(text: string, id = nextId()): Entry {
	return {
		type: "message",
		id,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	};
}

export function assistantEntry(text: string, options: { usageTokens?: number; stopReason?: string; id?: string } = {}): Entry {
	const usage = options.usageTokens !== undefined
		? { input: options.usageTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: options.usageTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
		: undefined;
	return {
		type: "message",
		id: options.id ?? nextId(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: options.stopReason ?? "stop",
			timestamp: Date.now(),
			...(usage ? { usage } : {}),
		},
	};
}

export function toolResultEntry(text: string, id = nextId()): Entry {
	return {
		type: "message",
		id,
		message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text }], timestamp: Date.now() },
	};
}

export function observation(seed: number, sourceEntryIds: string[], content = `observation ${seed}`): Observation {
	return {
		id: memoryId(seed),
		content,
		timestamp: "2026-01-01 10:00",
		relevance: "medium",
		sourceEntryIds,
		tokenCount: Math.ceil(content.length / 4),
	};
}

export function observationsRecordedEntry(observations: Observation[], coversUpToId: string, id = nextId("om")): Entry {
	return { type: "custom", id, customType: OM_OBSERVATIONS_RECORDED, data: { observations, coversUpToId } };
}

export function compactionEntry(firstKeptEntryId: string, id = nextId("c")): Entry {
	return { type: "compaction", id, firstKeptEntryId, summary: "summary" };
}

export function costEntry(usd: number, id = nextId("cost")): Entry {
	const data: CostEntryData = { usd, stages: { observer: usd } };
	return { type: "custom", id, customType: OM_COST, data };
}

export function enabledEntry(enabled: boolean, id = nextId("gate")): Entry {
	return { type: "custom", id, customType: OM_ENABLED, data: { enabled } };
}

export function text(tokens: number): string {
	return "x".repeat(tokens * 4);
}
