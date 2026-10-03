import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxNotifyExtension from "../../extensions/cmux-notify/index.ts";

type LifecycleEvent = "agent_end" | "agent_settled" | "tool_execution_start";
type LifecycleHandler = (event: unknown, context: unknown) => Promise<void> | void;

function createPi(sessionName: string | undefined) {
	const handlers = new Map<LifecycleEvent, LifecycleHandler>();
	const executions: [string, string[], unknown][] = [];
	const pi = {
		on(event: LifecycleEvent, handler: LifecycleHandler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return sessionName;
		},
		async exec(command: string, args: string[], options: unknown) {
			executions.push([command, args, options]);
			return {};
		},
	} as unknown as ExtensionAPI;
	return { executions, handlers, pi };
}

async function settle(pi: ReturnType<typeof createPi>, mode: "rpc" | "tui") {
	await pi.handlers.get("agent_end")?.({
		messages: [{ role: "assistant", content: [{ type: "text", text: "Finished." }] }],
	}, {});
	await pi.handlers.get("agent_settled")?.({}, {
		mode,
		hasUI: true,
		cwd: "/work/dotfiles",
		isIdle: () => true,
		hasPendingMessages: () => false,
	});
}

test("notifies immediately when ask_user_question starts, and only in cmux TUI sessions", async () => {
	const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
	const previousCli = process.env.CMUX_BUNDLED_CLI_PATH;
	process.env.CMUX_WORKSPACE_ID = "workspace-id";
	delete process.env.CMUX_BUNDLED_CLI_PATH;
	try {
		const ctx = { mode: "tui", cwd: "/work/dotfiles", isIdle: () => false, hasPendingMessages: () => false };

		const tui = createPi("release prep");
		cmuxNotifyExtension(tui.pi);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: { question: "Which option?" } }, ctx);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "bash", args: {} }, ctx);
		assert.deepEqual(tui.executions, [
			["cmux", ["notify", "--title", "Pi: Needs Input", "--body", "release prep: Which option?"], { timeout: 10_000 }],
		]);

		const rpc = createPi("release prep");
		cmuxNotifyExtension(rpc.pi);
		await rpc.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: {} }, { ...ctx, mode: "rpc" });
		assert.equal(rpc.executions.length, 0);
	} finally {
		if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
		else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
		if (previousCli === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
		else process.env.CMUX_BUNDLED_CLI_PATH = previousCli;
	}
});

test("notifies only in TUI mode and labels notifications with the Pi session name", async () => {
	const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
	const previousCli = process.env.CMUX_BUNDLED_CLI_PATH;
	process.env.CMUX_WORKSPACE_ID = "workspace-id";
	delete process.env.CMUX_BUNDLED_CLI_PATH;
	try {
		const rpc = createPi("release prep");
		cmuxNotifyExtension(rpc.pi);
		await settle(rpc, "rpc");
		assert.equal(rpc.executions.length, 0);

		const tui = createPi("release prep");
		cmuxNotifyExtension(tui.pi);
		await settle(tui, "tui");
		assert.deepEqual(tui.executions, [["cmux", ["notify", "--title", "Pi: Done", "--body", "release prep"], { timeout: 10_000 }]]);
	} finally {
		if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
		else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
		if (previousCli === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
		else process.env.CMUX_BUNDLED_CLI_PATH = previousCli;
	}
});
