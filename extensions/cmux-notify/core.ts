type Environment = Record<string, string | undefined>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

export function notificationArguments(label: string): string[] {
	return ["notify", "--title", "Pi: Needs Input", "--body", label];
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
