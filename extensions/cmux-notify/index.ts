import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	classifyNotification,
	isCmuxEnvironment,
	isInputPromptTool,
	lastAssistantResult,
	type NotificationKind,
	notificationArguments,
	promptLabel,
	resolveCmuxCli,
	sessionLabel,
} from "./core.ts";

export default function cmuxNotifyExtension(pi: ExtensionAPI) {
	let finalResult: unknown;

	async function notify(kind: NotificationKind, label: string) {
		try {
			await pi.exec(resolveCmuxCli(process.env), notificationArguments(kind, label), { timeout: 10_000 });
		} catch {}
	}

	pi.on("agent_end", async (event) => {
		finalResult = lastAssistantResult(event.messages);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isInputPromptTool(event.toolName) || ctx.mode !== "tui" || !isCmuxEnvironment(process.env)) return;
		void notify("Needs Input", promptLabel(sessionLabel(pi.getSessionName(), ctx.cwd), event.args));
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !isCmuxEnvironment(process.env) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const result = finalResult;
		finalResult = undefined;
		if (result === undefined) return;
		await notify(classifyNotification(result), sessionLabel(pi.getSessionName(), ctx.cwd));
	});
}
