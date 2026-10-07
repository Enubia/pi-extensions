import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

/**
 * Surface LLM failures from an agent-loop event stream.
 *
 * When the underlying LLM call fails, the loop ends the stream with a final
 * assistant message whose stopReason is "error" (or "aborted") — no exception
 * is thrown. Without this hook the drain loops treat such runs exactly like
 * "the model chose not to call the tool", which hides the real cause
 * (rate limits, oversized prompts, auth failures, ...) from the debug log.
 */
export function logAgentStreamError(stage: "observer" | "reflector" | "dropper", event: AgentEvent): void {
	if (event.type !== "message_end") return;
	const message = event.message;
	if (message.role !== "assistant") return;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
	debugLog(`${stage}.stream_error`, {
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	});
}

export class WorkerStreamError extends Error {
	readonly stopReason: string;
	readonly errorMessage: string | undefined;
	constructor(stage: "observer" | "reflector" | "dropper", stopReason: string, errorMessage?: string) {
		super(`${stage} stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "WorkerStreamError";
		this.stopReason = stopReason;
		this.errorMessage = errorMessage;
	}
}

export function streamFailureFromEvent(event: AgentEvent): { stopReason: string; errorMessage?: string } | undefined {
	if (event.type !== "message_end") return undefined;
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return { stopReason: message.stopReason, errorMessage: message.errorMessage };
}
