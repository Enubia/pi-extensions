export type NotificationKind = "Error" | "Needs Input" | "Done";

type Environment = Record<string, string | undefined>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => {
		const item = record(part);
		return item?.type === "text" && typeof item.text === "string" ? item.text : "";
	}).join("\n");
}

function resultText(result: Record<string, unknown>): string {
	if (typeof result.text === "string") return result.text;
	return textContent(result.content);
}

function isErrorResult(result: Record<string, unknown>): boolean {
	const stopReason = typeof result.stopReason === "string" ? result.stopReason.toLowerCase() : "";
	const status = typeof result.status === "string" ? result.status.toLowerCase() : "";
	return stopReason === "error" || stopReason === "aborted" || status === "error" || status === "aborted" || result.aborted === true;
}

function requestsInput(text: string): boolean {
	return /(?:^|\n)\s*(?:please\s+)?(?:let me know|tell me|provide|confirm|choose|decide|approve|clarify|respond|reply|answer)\b|\b(?:can|could|would|will)\s+you\b|\b(?:what|which|how)\s+(?:option|approach|direction|choice|should|would|do|can)\b|\b(?:do\s+you\s+want\s+me\s+to|should\s+i|are\s+you\s+okay\s+with)\b[^?\n]*\?/i.test(text);
}

export function classifyNotification(result: unknown): NotificationKind {
	const assistant = record(result);
	if (!assistant) return "Done";
	if (isErrorResult(assistant)) return "Error";
	return requestsInput(resultText(assistant)) ? "Needs Input" : "Done";
}

export function lastAssistantResult(messages: unknown): unknown {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = record(messages[index]);
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

export function sessionLabel(sessionName: string | undefined, cwd: string): string {
	const name = sessionName?.trim();
	if (name) return name;
	const normalized = cwd.replace(/[\\/]+$/, "");
	const basename = normalized.split(/[\\/]/).pop()?.trim();
	return basename || "session";
}

export function isCmuxEnvironment(environment: Environment): boolean {
	return Boolean(environment.CMUX_WORKSPACE_ID || environment.CMUX_TAB_ID || environment.CMUX_SOCKET_PATH);
}

export function resolveCmuxCli(environment: Environment): string {
	return environment.CMUX_BUNDLED_CLI_PATH?.trim() || "cmux";
}

export function notificationArguments(kind: NotificationKind, label: string): string[] {
	return ["notify", "--title", `Pi: ${kind}`, "--body", label];
}

const INPUT_PROMPT_TOOLS = new Set(["ask_user_question"]);
const MAX_QUESTION_LENGTH = 120;

export function isInputPromptTool(toolName: unknown): boolean {
	return typeof toolName === "string" && INPUT_PROMPT_TOOLS.has(toolName);
}

export function promptLabel(label: string, args: unknown): string {
	const question = record(args)?.question;
	if (typeof question !== "string") return label;
	const collapsed = question.replace(/\s+/g, " ").trim();
	if (!collapsed) return label;
	const clipped = collapsed.length > MAX_QUESTION_LENGTH ? `${collapsed.slice(0, MAX_QUESTION_LENGTH - 1).trimEnd()}…` : collapsed;
	return `${label}: ${clipped}`;
}
