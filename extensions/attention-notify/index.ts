import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTENTION_TEXT_USER_VAR, ATTENTION_USER_VAR, type AttentionState, attentionDirectory, attentionFileName, attentionValue, isInputPromptTool, isSubagentEnvironment, notificationArguments, oscSetUserVar, promptLabel, questionText, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand, weztermPane } from "./core.ts";
import { writeAttentionRecord } from "./store.ts";

type AttentionContext = { mode: string; cwd: string };

export default function attentionNotifyExtension(pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isInputPromptTool(event.toolName) || ctx.mode !== "tui") return;
		setAttention(ctx, "input", questionText(event.args));
		const backend = resolveBackend(process.env);
		if (!backend || backend === "vscode") return;
		if (backend === "cmux") {
			const label = promptLabel(sessionLabel(pi.getSessionName(), ctx.cwd), event.args);
			void pi.exec(resolveCmuxCli(process.env), notificationArguments(label), { timeout: 10_000 }).catch(() => {});
			return;
		}
		beep();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (isInputPromptTool(event.toolName)) setAttention(ctx, undefined);
	});

	pi.on("agent_start", async (_event, ctx) => {
		setAttention(ctx, undefined);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || isSubagentEnvironment(process.env)) return;
		setAttention(ctx, "done");
		if (resolveBackend(process.env) === "wezterm") beep();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setAttention(ctx, undefined);
	});

	function beep() {
		const sound = soundCommand(process.platform);
		if (sound) void pi.exec(sound[0], sound[1], { timeout: 10_000 }).catch(() => {});
	}

	function setAttention(ctx: AttentionContext, state: AttentionState | undefined, question?: string) {
		if (ctx.mode !== "tui") return;
		const now = Date.now();
		const token = attentionValue(state, now);
		const label = sessionLabel(pi.getSessionName(), ctx.cwd);
		const backend = resolveBackend(process.env);
		if (backend === "vscode") {
			process.stdout.write(oscSetUserVar(ATTENTION_TEXT_USER_VAR, state ? (question ?? label) : "") + oscSetUserVar(ATTENTION_USER_VAR, token));
			return;
		}
		const pane = weztermPane(process.env);
		writeAttentionRecord(
			attentionDirectory(process.env, homedir()),
			attentionFileName(process.env, process.pid),
			state && {
				pid: process.pid,
				state,
				token,
				label,
				...(question ? { question } : {}),
				cwd: ctx.cwd,
				...(pane === undefined ? {} : { weztermPane: pane }),
				updatedAt: now,
			},
		);
		if (backend === "wezterm") process.stdout.write(oscSetUserVar(ATTENTION_USER_VAR, token));
	}
}
