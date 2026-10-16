import { DEFAULT_SNAPSHOT_LIMIT, type CondensedEntry, type CondensedToolEntry, type ClientMessage, type ErrorCode, PROTOCOL_VERSION, type RemoteState, type SendMode, type ToolStatus } from "./protocol.ts";

const MAX_SUMMARY_LENGTH = 80;
const SUMMARY_ARG_KEYS = ["command", "pattern", "query", "url", "question", "path", "file_path", "description"];

type Message = { role?: string; timestamp?: number; content?: unknown; toolCallId?: string; isError?: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function summarizeToolCall(name: string, args: unknown): string {
	const object = record(args);
	if (!object) return name;
	for (const key of SUMMARY_ARG_KEYS) {
		const value = object[key];
		if (typeof value === "string" && collapse(value)) return `${name}: ${truncate(collapse(value), MAX_SUMMARY_LENGTH)}`;
	}
	if (Object.keys(object).length === 0) return name;
	return `${name}: ${truncate(JSON.stringify(object), MAX_SUMMARY_LENGTH)}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (record(part)?.type === "text" && typeof record(part)?.text === "string" ? [record(part)?.text as string] : [])).join("\n");
}

export function userEntry(message: Message): CondensedEntry | undefined {
	const text = textOf(message.content);
	if (!text.trim()) return undefined;
	const timestamp = message.timestamp ?? 0;
	return { id: `u:${timestamp}`, kind: "user", text, timestamp };
}

export function assistantTextEntry(message: Message): CondensedEntry | undefined {
	const text = textOf(message.content);
	if (!text.trim()) return undefined;
	const timestamp = message.timestamp ?? 0;
	return { id: `a:${timestamp}`, kind: "assistant", text, timestamp };
}

export function assistantMessageId(message: Message): string {
	return `a:${message.timestamp ?? 0}`;
}

export function toolEntry(toolCallId: string, name: string, args: unknown, status: ToolStatus, timestamp: number, durationMs?: number): CondensedToolEntry {
	return {
		id: `t:${toolCallId}`,
		kind: "tool",
		toolCallId,
		name,
		summary: summarizeToolCall(name, args),
		args,
		status,
		...(durationMs === undefined ? {} : { durationMs }),
		timestamp,
	};
}

export function condenseEntries(branch: readonly unknown[], durations: ReadonlyMap<string, number> = new Map()): CondensedEntry[] {
	const messages = branch.flatMap((entry) => {
		const item = record(entry);
		const message = item?.type === "message" ? record(item.message) : undefined;
		return message ? [message as Message] : [];
	});
	const results = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message.isError === true);
	}
	const entries: CondensedEntry[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const entry = userEntry(message);
			if (entry) entries.push(entry);
		} else if (message.role === "assistant") {
			const text = assistantTextEntry(message);
			if (text) entries.push(text);
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				const call = record(part);
				if (call?.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
				const failed = results.get(call.id);
				const status: ToolStatus = failed === undefined ? "running" : failed ? "error" : "ok";
				entries.push(toolEntry(call.id, call.name, call.arguments, status, message.timestamp ?? 0, durations.get(call.id)));
			}
		}
	}
	return entries;
}

export function pageEntries(entries: readonly CondensedEntry[], before: string | undefined, limit: number | undefined): { entries: CondensedEntry[]; hasMore: boolean } {
	const size = limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SNAPSHOT_LIMIT;
	let end = entries.length;
	if (before !== undefined) {
		end = entries.findIndex((entry) => entry.id === before);
		if (end < 0) return { entries: [], hasMore: false };
	}
	const start = Math.max(0, end - size);
	return { entries: entries.slice(start, end), hasMore: start > 0 };
}

export function routeSend(idle: boolean, mode: SendMode): { deliverAs?: "steer" | "followUp" } {
	if (idle) return {};
	return { deliverAs: mode === "followUp" ? "followUp" : "steer" };
}

export function createStateTracker() {
	let busy = false;
	let dialogs = 0;
	const questions = new Set<string>();
	return {
		agentStart() {
			busy = true;
		},
		agentSettled() {
			busy = false;
		},
		dialogStart() {
			dialogs++;
		},
		dialogEnd() {
			dialogs = Math.max(0, dialogs - 1);
		},
		questionStart(id: string) {
			questions.add(id);
		},
		questionEnd(id: string) {
			questions.delete(id);
		},
		state(): RemoteState {
			if (questions.size > 0) return "input";
			if (dialogs > 0) return "tui-dialog";
			return busy ? "busy" : "idle";
		},
	};
}

export type ValidationResult = { ok: true; message: ClientMessage } | { ok: false; id?: string; code: ErrorCode; message: string };

function invalid(id: string | undefined, code: ErrorCode, message: string): ValidationResult {
	return { ok: false, ...(id === undefined ? {} : { id }), code, message };
}

export function validateClientMessage(value: unknown): ValidationResult {
	const message = record(value);
	if (!message) return invalid(undefined, "bad_request", "message must be an object");
	const id = typeof message.id === "string" ? message.id : undefined;
	if (message.v !== PROTOCOL_VERSION) return invalid(id, "incompatible", `unsupported protocol version ${String(message.v)}`);
	if (id === undefined) return invalid(undefined, "bad_request", "id is required");
	switch (message.type) {
		case "abort":
			return { ok: true, message: message as ClientMessage };
		case "snapshot":
			if (message.before !== undefined && typeof message.before !== "string") return invalid(id, "bad_request", "before must be a string");
			if (message.limit !== undefined && typeof message.limit !== "number") return invalid(id, "bad_request", "limit must be a number");
			return { ok: true, message: message as ClientMessage };
		case "send":
			if (typeof message.text !== "string" || !message.text.trim()) return invalid(id, "bad_request", "text is required");
			if (message.mode !== "auto" && message.mode !== "followUp") return invalid(id, "bad_request", "mode must be auto or followUp");
			return { ok: true, message: message as ClientMessage };
		default:
			return invalid(id, "unknown_type", `unknown message type ${String(message.type)}`);
	}
}
