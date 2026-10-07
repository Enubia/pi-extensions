import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import attentionNotifyExtension from "../../extensions/attention-notify/index.ts";

type LifecycleEvent = "tool_execution_start";
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

test("notifies immediately when ask_user_question starts, and only in cmux TUI sessions", async () => {
	const previousWorkspace = process.env.CMUX_WORKSPACE_ID;
	const previousCli = process.env.CMUX_BUNDLED_CLI_PATH;
	process.env.CMUX_WORKSPACE_ID = "workspace-id";
	delete process.env.CMUX_BUNDLED_CLI_PATH;
	try {
		const ctx = { mode: "tui", cwd: "/work/dotfiles", isIdle: () => false, hasPendingMessages: () => false };

		const tui = createPi("release prep");
		attentionNotifyExtension(tui.pi);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: { question: "Which option?" } }, ctx);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "bash", args: {} }, ctx);
		assert.deepEqual(tui.executions, [
			["cmux", ["notify", "--title", "Pi: Needs Input", "--body", "release prep: Which option?"], { timeout: 10_000 }],
		]);

		const rpc = createPi("release prep");
		attentionNotifyExtension(rpc.pi);
		await rpc.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: {} }, { ...ctx, mode: "rpc" });
		assert.equal(rpc.executions.length, 0);
	} finally {
		if (previousWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
		else process.env.CMUX_WORKSPACE_ID = previousWorkspace;
		if (previousCli === undefined) delete process.env.CMUX_BUNDLED_CLI_PATH;
		else process.env.CMUX_BUNDLED_CLI_PATH = previousCli;
	}
});

test("writes an OSC 777 notification and plays a sound in WezTerm TUI sessions", async () => {
	const keys = ["CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_SOCKET_PATH", "TERM_PROGRAM"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.TERM_PROGRAM = "WezTerm";
	const originalWrite = process.stdout.write;
	const written: string[] = [];
	process.stdout.write = ((chunk: string) => {
		written.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		const ctx = { mode: "tui", cwd: "/work/dotfiles" };
		const tui = createPi(undefined);
		attentionNotifyExtension(tui.pi);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: { question: "Which option?" } }, ctx);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: {} }, { ...ctx, mode: "rpc" });
		assert.deepEqual(written, ["\x1b]777;notify;Pi: Needs Input;dotfiles: Which option?\x1b\\"]);
		const expectedSound = process.platform === "darwin" ? [["afplay", ["/System/Library/Sounds/Glass.aiff"], { timeout: 10_000 }]] : [];
		assert.deepEqual(tui.executions, expectedSound);
	} finally {
		process.stdout.write = originalWrite;
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});
