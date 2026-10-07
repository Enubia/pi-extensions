import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DONE_TITLE, isInputPromptTool, isSubagentEnvironment, notificationArguments, osc777Notification, promptLabel, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand } from "./core.ts";

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
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || isSubagentEnvironment(process.env)) return;
		if (resolveBackend(process.env) !== "wezterm") return;
		notifyWezTerm(sessionLabel(pi.getSessionName(), ctx.cwd), DONE_TITLE);
	});

	function notifyWezTerm(label: string, title?: string) {
		process.stdout.write(osc777Notification(label, title));
		const sound = soundCommand(process.platform);
		if (sound) void pi.exec(sound[0], sound[1], { timeout: 10_000 }).catch(() => {});
	}
}
