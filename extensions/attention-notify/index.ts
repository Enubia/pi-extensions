import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInputPromptTool, notificationArguments, osc777Notification, promptLabel, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand } from "./core.ts";

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
		process.stdout.write(osc777Notification(label));
		const sound = soundCommand(process.platform);
		if (sound) void pi.exec(sound[0], sound[1], { timeout: 10_000 }).catch(() => {});
	});
}
