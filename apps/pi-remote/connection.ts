import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import {
	encodeMessage,
	parseLine,
	PROTOCOL_VERSION,
	type ClientMessage,
	type CondensedEntry,
	type HelloMessage,
	type QuestionMessage,
	type RemoteState,
	type ServerMessage,
} from "../../extensions/remote/protocol.ts";

const MAX_LINE_LENGTH = 4_000_000;

export type SessionQuestion = {
	toolCallId: string;
	question: string;
	details?: string;
	mode: QuestionMessage["mode"];
	options: QuestionMessage["options"];
};

export type SessionInfo = {
	pid: number;
	sessionId?: string;
	label: string;
	cwd?: string;
	state: RemoteState;
	lastActivity: number;
	subagentId?: string;
	parentSession?: string;
	incompatible: boolean;
	question?: SessionQuestion;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type RequestPayload = DistributiveOmit<ClientMessage, "v" | "id">;

export type ReplyMessage = Extract<ServerMessage, { type: "ack" | "snapshot_result" }>;

export class RequestError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export type ConnectionHandlers = {
	onReady(): void;
	onChange(): void;
	onEntry(entry: CondensedEntry): void;
	onTextDelta(id: string, delta: string): void;
	onClose(error?: NodeJS.ErrnoException): void;
};

export type SessionConnection = {
	info: SessionInfo;
	request(payload: RequestPayload, timeoutMs: number): Promise<ReplyMessage>;
	close(): void;
};

type Pending = { resolve(message: ReplyMessage): void; reject(error: RequestError): void; timer: NodeJS.Timeout };

export function connectSession(path: string, pid: number, handlers: ConnectionHandlers): SessionConnection {
	const info: SessionInfo = { pid, label: `pid ${pid}`, state: "idle", lastActivity: 0, incompatible: false };
	const pending = new Map<string, Pending>();
	const socket = connect(path);
	socket.setEncoding("utf8");
	let ready = false;
	let buffer = "";
	let closed = false;
	let failure: NodeJS.ErrnoException | undefined;

	const markReady = () => {
		if (ready) return;
		ready = true;
		handlers.onReady();
	};

	const applyHello = (message: HelloMessage) => {
		info.sessionId = message.sessionId;
		info.label = message.label;
		info.cwd = message.cwd;
		info.state = message.state;
		info.lastActivity = message.lastActivity;
		info.subagentId = message.subagentId;
		info.parentSession = message.parentSession;
	};

	const handle = (value: unknown) => {
		if (typeof value !== "object" || value === null) return;
		const message = value as ServerMessage;
		if (message.v !== PROTOCOL_VERSION) {
			info.incompatible = true;
			if (message.type === "hello") applyHello(message);
			if (ready) handlers.onChange();
			else markReady();
			return;
		}
		switch (message.type) {
			case "hello":
				applyHello(message);
				if (ready) handlers.onChange();
				else markReady();
				return;
			case "state":
				info.state = message.state;
				info.lastActivity = message.lastActivity;
				handlers.onChange();
				return;
			case "label":
				info.label = message.label;
				handlers.onChange();
				return;
			case "question":
				info.question = { toolCallId: message.toolCallId, question: message.question, details: message.details, mode: message.mode, options: message.options };
				handlers.onChange();
				return;
			case "question_closed":
				if (info.question?.toolCallId === message.toolCallId) {
					info.question = undefined;
					handlers.onChange();
				}
				return;
			case "entry":
				handlers.onEntry(message.entry);
				return;
			case "text_delta":
				handlers.onTextDelta(message.id, message.delta);
				return;
			case "snapshot_result":
			case "ack": {
				const entry = pending.get(message.id);
				if (!entry) return;
				pending.delete(message.id);
				clearTimeout(entry.timer);
				entry.resolve(message);
				return;
			}
			case "error": {
				if (message.code === "incompatible") {
					info.incompatible = true;
					handlers.onChange();
				}
				const entry = message.id === undefined ? undefined : pending.get(message.id);
				if (!entry || message.id === undefined) return;
				pending.delete(message.id);
				clearTimeout(entry.timer);
				entry.reject(new RequestError(message.code, message.message));
				return;
			}
		}
	};

	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_LINE_LENGTH && !buffer.includes("\n")) {
			socket.destroy();
			return;
		}
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			handle(parseLine(line));
		}
	});
	socket.on("error", (error: NodeJS.ErrnoException) => {
		failure = error;
	});
	socket.on("close", () => {
		if (closed) return;
		closed = true;
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new RequestError("closed", "session closed"));
		}
		pending.clear();
		handlers.onClose(failure);
	});

	return {
		info,
		request(payload, timeoutMs) {
			if (info.incompatible) return Promise.reject(new RequestError("incompatible", "session protocol version is incompatible; /reload it"));
			if (closed || socket.destroyed) return Promise.reject(new RequestError("closed", "session closed"));
			const id = randomUUID();
			return new Promise<ReplyMessage>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new RequestError("timeout", "session did not answer in time"));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				socket.write(encodeMessage({ ...payload, v: PROTOCOL_VERSION, id } as ClientMessage));
			});
		},
		close() {
			socket.destroy();
		},
	};
}
