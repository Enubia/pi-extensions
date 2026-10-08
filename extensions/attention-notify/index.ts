import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTENTION_USER_VAR, type AttentionState, attentionValue, DONE_TITLE, isInputPromptTool, isSubagentEnvironment, notificationArguments, osc777Notification, oscSetUserVar, promptLabel, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand } from "./core.ts";

type ModeContext = { mode: string };

export default function attentionNotifyExtension(pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isInputPromptTool(event.toolName) || ctx.mode !== "tui") return;
		const backend = resolveBackend(process.env);
		if (!backend) return;
		const label = promptLabel(sessionLabel(pi.getSessionName(), ctx.cwd), event.args);
		if (backend === "cmux") {
			void pi.exec(resolveCmuxCli(process.env), notificationArguments(label), { timeout: 10_000 }).catch(() => {});
			return;
		}
		notifyWezTerm(label);
		setWezTermAttention(ctx, "input");
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (isInputPromptTool(event.toolName)) setWezTermAttention(ctx, undefined);
	});

	pi.on("agent_start", async (_event, ctx) => {
		setWezTermAttention(ctx, undefined);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || isSubagentEnvironment(process.env)) return;
		if (resolveBackend(process.env) !== "wezterm") return;
		notifyWezTerm(sessionLabel(pi.getSessionName(), ctx.cwd), DONE_TITLE);
		setWezTermAttention(ctx, "done");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setWezTermAttention(ctx, undefined);
	});

	function notifyWezTerm(label: string, title?: string) {
		process.stdout.write(osc777Notification(label, title));
		const sound = soundCommand(process.platform);
		if (sound) void pi.exec(sound[0], sound[1], { timeout: 10_000 }).catch(() => {});
	}

	function setWezTermAttention(ctx: ModeContext, state: AttentionState | undefined) {
		if (ctx.mode !== "tui" || resolveBackend(process.env) !== "wezterm") return;
		process.stdout.write(oscSetUserVar(ATTENTION_USER_VAR, attentionValue(state, Date.now())));
	}
}
