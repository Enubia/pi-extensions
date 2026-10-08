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

export type NotificationBackend = "cmux" | "wezterm";

export function isCmuxEnvironment(environment: Environment): boolean {
	return Boolean(environment.CMUX_WORKSPACE_ID || environment.CMUX_TAB_ID || environment.CMUX_SOCKET_PATH);
}

export function isWezTermEnvironment(environment: Environment): boolean {
	if (environment.TERM_PROGRAM === "WezTerm") return true;
	return Boolean(environment.WEZTERM_PANE) && !environment.TMUX;
}

export function resolveBackend(environment: Environment): NotificationBackend | undefined {
	if (isCmuxEnvironment(environment)) return "cmux";
	if (isWezTermEnvironment(environment)) return "wezterm";
	return undefined;
}

export function resolveCmuxCli(environment: Environment): string {
	return environment.CMUX_BUNDLED_CLI_PATH?.trim() || "cmux";
}

export const NEEDS_INPUT_TITLE = "Pi: Needs Input";
export const DONE_TITLE = "Pi: Done";

export function notificationArguments(label: string, title = NEEDS_INPUT_TITLE): string[] {
	return ["notify", "--title", title, "--body", label];
}

export function soundCommand(platform: NodeJS.Platform): [string, string[]] | undefined {
	if (platform !== "darwin") return undefined;
	return ["osascript", ["-e", "beep"]];
}

function oscField(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/;/g, ",");
}

export function osc777Notification(label: string, title = NEEDS_INPUT_TITLE): string {
	return `\x1b]777;notify;${oscField(title)};${oscField(label)}\x1b\\`;
}

export const ATTENTION_USER_VAR = "pi_attention";

export type AttentionState = "input" | "done";

export function attentionValue(state: AttentionState | undefined, now: number): string {
	return state ? `${state}:${now}` : "";
}

export function oscSetUserVar(name: string, value: string): string {
	return `\x1b]1337;SetUserVar=${name}=${Buffer.from(value).toString("base64")}\x07`;
}

export function isSubagentEnvironment(environment: Environment): boolean {
	return Boolean(environment.PI_SUBAGENT_ID);
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
