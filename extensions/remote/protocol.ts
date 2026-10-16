import type { QuestionMode, QuestionOption, RemoteAnswerInput } from "../question-events.ts";

export const PROTOCOL_VERSION = 1;

export type RemoteState = "busy" | "input" | "tui-dialog" | "idle";

export type SendMode = "auto" | "followUp";

export type ToolStatus = "running" | "ok" | "error";

export type CondensedUserEntry = { id: string; kind: "user"; text: string; timestamp: number };

export type CondensedAssistantEntry = { id: string; kind: "assistant"; text: string; timestamp: number };

export type CondensedToolEntry = {
	id: string;
	kind: "tool";
	toolCallId: string;
	name: string;
	summary: string;
	args: unknown;
	status: ToolStatus;
	durationMs?: number;
	timestamp: number;
};

export type CondensedEntry = CondensedUserEntry | CondensedAssistantEntry | CondensedToolEntry;

type Versioned<T> = { v: number } & T;

export type SnapshotRequest = Versioned<{ type: "snapshot"; id: string; before?: string; limit?: number }>;

export type SendRequest = Versioned<{ type: "send"; id: string; text: string; mode: SendMode }>;

export type AbortRequest = Versioned<{ type: "abort"; id: string }>;

export type AnswerRequest = Versioned<{ type: "answer"; id: string; toolCallId: string; answers: RemoteAnswerInput[] }>;

export type ClientMessage = SnapshotRequest | SendRequest | AbortRequest | AnswerRequest;

export type HelloMessage = Versioned<{
	type: "hello";
	pid: number;
	sessionId: string;
	label: string;
	cwd: string;
	state: RemoteState;
	subagentId?: string;
	parentSession?: string;
	lastActivity: number;
}>;

export type StateMessage = Versioned<{ type: "state"; state: RemoteState; lastActivity: number }>;

export type LabelMessage = Versioned<{ type: "label"; label: string }>;

export type SnapshotResultMessage = Versioned<{ type: "snapshot_result"; id: string; entries: CondensedEntry[]; hasMore: boolean }>;

export type EntryMessage = Versioned<{ type: "entry"; entry: CondensedEntry }>;

export type TextDeltaMessage = Versioned<{ type: "text_delta"; id: string; delta: string }>;

export type AckMessage = Versioned<{ type: "ack"; id: string }>;

export type QuestionMessage = Versioned<{
	type: "question";
	toolCallId: string;
	question: string;
	details?: string;
	mode: QuestionMode;
	options: QuestionOption[];
}>;

export type QuestionClosedMessage = Versioned<{ type: "question_closed"; toolCallId: string }>;

export type ErrorCode = "incompatible" | "bad_request" | "unknown_type" | "failed" | "stale";

export type ErrorMessage = Versioned<{ type: "error"; id?: string; code: ErrorCode; message: string }>;

export type ServerMessage = HelloMessage | StateMessage | LabelMessage | SnapshotResultMessage | EntryMessage | TextDeltaMessage | AckMessage | QuestionMessage | QuestionClosedMessage | ErrorMessage;

export const DEFAULT_SNAPSHOT_LIMIT = 50;

export function encodeMessage(message: ServerMessage | ClientMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}
