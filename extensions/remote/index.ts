import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInputPromptTool, sessionLabel } from "../attention-notify/core.ts";
import { assistantMessageId, boundEntry, assistantTextEntry, condenseEntries, createStateTracker, pageEntries, record, routeSend, toolEntry, userEntry, validateClientMessage } from "./core.ts";
import { QUESTION_ANSWER_EVENT, QUESTION_CLOSED_EVENT, QUESTION_OPENED_EVENT, type QuestionClosed, type QuestionOpened, resolveRemoteAnswers } from "../question-events.ts";
import { type ClientMessage, type CondensedEntry, type ErrorCode, PROTOCOL_VERSION, type RemoteState, type ServerMessage } from "./protocol.ts";
import { type RemoteClient, type SocketServer, startSocketServer } from "./server.ts";

const MAX_TRACKED_DURATIONS = 2000;

function remoteDirectory(): string {
	return process.env.PI_REMOTE_DIR?.trim() || join(homedir(), ".pi", "agent", "remote");
}

export default function remoteExtension(pi: ExtensionAPI) {
	const tracker = createStateTracker();
	const durations = new Map<string, number>();
	const toolCalls = new Map<string, { args: unknown; timestamp: number }>();
	let server: SocketServer | undefined;
	let pendingQuestion: QuestionOpened | undefined;
	let stopQuestionListeners: (() => void) | undefined;
	let current: ExtensionContext | undefined;
	let publishedState: RemoteState = "idle";
	let lastActivity = Date.now();

	function v<T extends { type: string }>(message: T): T & { v: number } {
		return { v: PROTOCOL_VERSION, ...message };
	}

	function label(): string {
		return sessionLabel(pi.getSessionName(), current?.cwd ?? "");
	}

	function touch() {
		lastActivity = Date.now();
	}

	function publish(message: ServerMessage) {
		server?.broadcast(message);
	}

	function syncState() {
		const next = tracker.state();
		if (next === publishedState) return;
		publishedState = next;
		touch();
		publish(v({ type: "state", state: next, lastActivity }));
	}

	function reply(client: RemoteClient, message: ServerMessage) {
		client.send(message);
	}

	function fail(client: RemoteClient, id: string | undefined, code: ErrorCode, message: string) {
		reply(client, v({ type: "error", ...(id === undefined ? {} : { id }), code, message }));
	}

	function hello(client: RemoteClient) {
		const ctx = current;
		if (!ctx) return;
		reply(client, v({
			type: "hello",
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			label: label(),
			cwd: ctx.cwd,
			state: tracker.state(),
			...(process.env.PI_SUBAGENT_ID ? { subagentId: process.env.PI_SUBAGENT_ID } : {}),
			...(process.env.PI_SUBAGENT_PARENT_SESSION ? { parentSession: process.env.PI_SUBAGENT_PARENT_SESSION } : {}),
			lastActivity,
		}));
		if (pendingQuestion) reply(client, questionMessage(pendingQuestion));
	}

	function questionMessage(question: QuestionOpened): ServerMessage {
		return v({
			type: "question",
			toolCallId: question.toolCallId,
			question: question.question,
			...(question.details === undefined ? {} : { details: question.details }),
			mode: question.mode,
			options: question.options,
		});
	}

	function answer(client: RemoteClient, message: Extract<ClientMessage, { type: "answer" }>) {
		const question = pendingQuestion;
		if (!question || question.toolCallId !== message.toolCallId) {
			fail(client, message.id, "stale", "question is no longer pending");
			return;
		}
		if (!resolveRemoteAnswers(question, message.answers)) {
			fail(client, message.id, "bad_request", "answers do not fit the question");
			return;
		}
		pendingQuestion = undefined;
		pi.events.emit(QUESTION_ANSWER_EVENT, { toolCallId: message.toolCallId, answers: message.answers });
		reply(client, v({ type: "ack", id: message.id }));
	}

	function listenForQuestions() {
		const offOpened = pi.events.on(QUESTION_OPENED_EVENT, (data) => {
			const question = data as QuestionOpened;
			pendingQuestion = question;
			publish(questionMessage(question));
		});
		const offClosed = pi.events.on(QUESTION_CLOSED_EVENT, (data) => {
			const { toolCallId } = data as QuestionClosed;
			if (pendingQuestion?.toolCallId === toolCallId) pendingQuestion = undefined;
			publish(v({ type: "question_closed", toolCallId }));
		});
		stopQuestionListeners = () => {
			offOpened();
			offClosed();
		};
	}

	function handleMessage(client: RemoteClient, message: ClientMessage) {
		const ctx = current;
		if (!ctx) return;
		switch (message.type) {
			case "snapshot": {
				const page = pageEntries(condenseEntries(ctx.sessionManager.getBranch(), durations), message.before, message.limit);
				reply(client, v({ type: "snapshot_result", id: message.id, entries: page.entries, hasMore: page.hasMore }));
				return;
			}
			case "send":
				pi.sendUserMessage(message.text, { ...routeSend(ctx.isIdle(), message.mode), expandPromptTemplates: true });
				reply(client, v({ type: "ack", id: message.id }));
				return;
			case "answer":
				answer(client, message);
				return;
			case "abort":
				ctx.abort();
				reply(client, v({ type: "ack", id: message.id }));
				return;
		}
	}

	function onLine(client: RemoteClient, value: unknown) {
		const result = validateClientMessage(value);
		if (!result.ok) {
			fail(client, result.id, result.code, result.message);
			return;
		}
		try {
			handleMessage(client, result.message);
		} catch (error) {
			fail(client, result.message.id, "failed", error instanceof Error ? error.message : "request failed");
		}
	}

	function emitEntry(entry: CondensedEntry | undefined) {
		if (!entry) return;
		touch();
		publish(v({ type: "entry", entry: boundEntry(entry) }));
	}

	function stop() {
		stopQuestionListeners?.();
		stopQuestionListeners = undefined;
		pendingQuestion = undefined;
		server?.close();
		server = undefined;
		publishedState = "idle";
		tracker.reset();
	}

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		current = ctx;
		listenForQuestions();
		try {
			server = startSocketServer(remoteDirectory(), process.pid, { onConnect: hello, onLine });
		} catch {
			server = undefined;
		}
	});

	pi.on("session_shutdown", async () => {
		stop();
		current = undefined;
	});

	pi.on("session_info_changed", async () => {
		if (!server) return;
		publish(v({ type: "label", label: label() }));
	});

	pi.on("agent_start", async () => {
		tracker.agentStart();
		syncState();
	});

	pi.on("agent_settled", async () => {
		tracker.agentSettled();
		syncState();
	});

	pi.on("ui_prompt_start", async () => {
		tracker.dialogStart();
		syncState();
	});

	pi.on("ui_prompt_end", async () => {
		tracker.dialogEnd();
		syncState();
	});

	pi.on("message_update", async (event) => {
		if (!server) return;
		const update = record(event.assistantMessageEvent);
		if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
		touch();
		publish(v({ type: "text_delta", id: assistantMessageId(event.message), delta: update.delta }));
	});

	pi.on("message_end", async (event) => {
		if (!server) return;
		const message = event.message;
		if (message.role === "assistant") emitEntry(assistantTextEntry(message));
		else if (message.role === "user") emitEntry(userEntry(message));
	});

	pi.on("tool_execution_start", async (event) => {
		if (isInputPromptTool(event.toolName)) tracker.questionStart(event.toolCallId);
		if (server && !event.parentToolCallId) {
			const timestamp = Date.now();
			toolCalls.set(event.toolCallId, { args: event.args, timestamp });
			emitEntry(toolEntry(event.toolCallId, event.toolName, event.args, "running", timestamp));
		}
		syncState();
	});

	pi.on("tool_execution_end", async (event) => {
		if (isInputPromptTool(event.toolName)) tracker.questionEnd(event.toolCallId);
		const started = toolCalls.get(event.toolCallId);
		toolCalls.delete(event.toolCallId);
		if (server) {
			if (event.durationMs !== undefined) {
				durations.set(event.toolCallId, event.durationMs);
				if (durations.size > MAX_TRACKED_DURATIONS) durations.delete(durations.keys().next().value as string);
			}
			if (!event.parentToolCallId) emitEntry(toolEntry(event.toolCallId, event.toolName, started?.args, event.isError ? "error" : "ok", started?.timestamp ?? Date.now(), event.durationMs));
		}
		syncState();
	});
}
