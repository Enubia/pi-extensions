import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTENTION_USER_VAR, type AttentionState, attentionDirectory, attentionFileName, attentionValue, DONE_TITLE, isInputPromptTool, isSubagentEnvironment, notificationArguments, osc777Notification, oscSetUserVar, promptLabel, questionText, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand, weztermPane } from "./core.ts";
import { writeAttentionRecord } from "./store.ts";

type AttentionContext = { mode: string; cwd: string };

export default function attentionNotifyExtension(pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isInputPromptTool(event.toolName) || ctx.mode !== "tui") return;
		setAttention(ctx, "input", questionText(event.args));
		const backend = resolveBackend(process.env);
		if (!backend) return;
		const label = promptLabel(sessionLabel(pi.getSessionName(), ctx.cwd), event.args);
		if (backend === "cmux") {
			void pi.exec(resolveCmuxCli(process.env), notificationArguments(label), { timeout: 10_000 }).catch(() => {});
			return;
		}
		notifyWezTerm(label);
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
		if (resolveBackend(process.env) !== "wezterm") return;
		notifyWezTerm(sessionLabel(pi.getSessionName(), ctx.cwd), DONE_TITLE);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setAttention(ctx, undefined);
	});

	function notifyWezTerm(label: string, title?: string) {
		process.stdout.write(osc777Notification(label, title));
		const sound = soundCommand(process.platform);
		if (sound) void pi.exec(sound[0], sound[1], { timeout: 10_000 }).catch(() => {});
	}

	function setAttention(ctx: AttentionContext, state: AttentionState | undefined, question?: string) {
		if (ctx.mode !== "tui") return;
		const now = Date.now();
		const token = attentionValue(state, now);
		const pane = weztermPane(process.env);
		writeAttentionRecord(
			attentionDirectory(process.env, homedir()),
			attentionFileName(process.env, process.pid),
			state && {
				pid: process.pid,
				state,
				token,
				label: sessionLabel(pi.getSessionName(), ctx.cwd),
				...(question ? { question } : {}),
				cwd: ctx.cwd,
				...(pane === undefined ? {} : { weztermPane: pane }),
				updatedAt: now,
			},
		);
		if (resolveBackend(process.env) === "wezterm") process.stdout.write(oscSetUserVar(ATTENTION_USER_VAR, token));
	}
}
