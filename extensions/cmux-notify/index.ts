import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCmuxEnvironment, isInputPromptTool, notificationArguments, promptLabel, resolveCmuxCli, sessionLabel } from "./core.ts";

export default function cmuxNotifyExtension(pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isInputPromptTool(event.toolName) || ctx.mode !== "tui" || !isCmuxEnvironment(process.env)) return;
		const label = promptLabel(sessionLabel(pi.getSessionName(), ctx.cwd), event.args);
		void pi.exec(resolveCmuxCli(process.env), notificationArguments(label), { timeout: 10_000 }).catch(() => {});
	});
}
