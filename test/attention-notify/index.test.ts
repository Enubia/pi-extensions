import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import attentionNotifyExtension from "../../extensions/attention-notify/index.ts";

process.env.PI_ATTENTION_DIR = join(tmpdir(), "pi-attention-notify-missing");

function decodeUserVars(written: string[]): string[] {
	return written.flatMap((chunk) => {
		const match = /^\x1b\]1337;SetUserVar=pi_attention=([A-Za-z0-9+/=]*)\x07$/.exec(chunk);
		return match ? [Buffer.from(match[1], "base64").toString().replace(/:\d+$/, "")] : [];
	});
}

function notifications(written: string[]): string[] {
	return written.filter((chunk) => chunk.startsWith("\x1b]777;"));
}

const expectedBeep = process.platform === "darwin" ? [["osascript", ["-e", "beep"], { timeout: 10_000 }]] : [];

type LifecycleEvent = "tool_execution_start" | "tool_execution_end" | "agent_start" | "agent_settled" | "session_shutdown";
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

test("beeps without a notification popup when input is needed in WezTerm TUI sessions", async () => {
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
		assert.deepEqual(notifications(written), []);
		assert.deepEqual(decodeUserVars(written), ["input"]);
		assert.deepEqual(tui.executions, expectedBeep);
	} finally {
		process.stdout.write = originalWrite;
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test("beeps on agent_settled in WezTerm TUI main sessions only", async () => {
	const keys = ["CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_SOCKET_PATH", "TERM_PROGRAM", "PI_SUBAGENT_ID"] as const;
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
		const tui = createPi("release prep");
		attentionNotifyExtension(tui.pi);
		await tui.handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		await tui.handlers.get("agent_settled")?.({ type: "agent_settled" }, { ...ctx, mode: "rpc" });
		process.env.PI_SUBAGENT_ID = "child";
		await tui.handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		assert.deepEqual(notifications(written), []);
		assert.deepEqual(decodeUserVars(written), ["done"]);
		assert.deepEqual(tui.executions, expectedBeep);
	} finally {
		process.stdout.write = originalWrite;
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test("clears the WezTerm attention user var when work resumes or the session ends", async () => {
	const keys = ["CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_SOCKET_PATH", "TERM_PROGRAM", "PI_SUBAGENT_ID"] as const;
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
		await tui.handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: {} }, ctx);
		await tui.handlers.get("tool_execution_end")?.({ toolName: "ask_user_question" }, ctx);
		await tui.handlers.get("tool_execution_end")?.({ toolName: "bash" }, ctx);
		await tui.handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		await tui.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		await tui.handlers.get("agent_start")?.({ type: "agent_start" }, { ...ctx, mode: "rpc" });
		assert.deepEqual(decodeUserVars(written), ["", "input", "", "done", ""]);
	} finally {
		process.stdout.write = originalWrite;
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});

test("mirrors attention state into the attention directory when it exists", async () => {
	const keys = ["CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_SOCKET_PATH", "TERM_PROGRAM", "PI_SUBAGENT_ID", "WEZTERM_PANE", "TMUX", "PI_ATTENTION_DIR"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	const directory = mkdtempSync(join(tmpdir(), "pi-attention-"));
	process.env.PI_ATTENTION_DIR = directory;
	process.env.TERM_PROGRAM = "WezTerm";
	process.env.WEZTERM_PANE = "7";
	const originalWrite = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		const ctx = { mode: "tui", cwd: "/work/dotfiles" };
		const tui = createPi("release prep");
		attentionNotifyExtension(tui.pi);
		await tui.handlers.get("tool_execution_start")?.({ toolName: "ask_user_question", args: { question: "Ship it?" } }, ctx);
		assert.deepEqual(readdirSync(directory), ["pane-7.json"]);
		const record = JSON.parse(readFileSync(join(directory, "pane-7.json"), "utf8"));
		assert.equal(record.pid, process.pid);
		assert.equal(record.state, "input");
		assert.match(record.token, /^input:\d+$/);
		assert.equal(record.label, "release prep");
		assert.equal(record.question, "Ship it?");
		assert.equal(record.cwd, "/work/dotfiles");
		assert.equal(record.weztermPane, 7);

		await tui.handlers.get("tool_execution_end")?.({ toolName: "ask_user_question" }, ctx);
		assert.deepEqual(readdirSync(directory), []);

		await tui.handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		assert.equal(JSON.parse(readFileSync(join(directory, "pane-7.json"), "utf8")).state, "done");

		await tui.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		assert.equal(existsSync(join(directory, "pane-7.json")), false);
	} finally {
		process.stdout.write = originalWrite;
		rmSync(directory, { recursive: true, force: true });
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});
