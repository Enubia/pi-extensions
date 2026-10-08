import assert from "node:assert/strict";
import test from "node:test";
import { attentionValue, isCmuxEnvironment, isInputPromptTool, isWezTermEnvironment, notificationArguments, osc777Notification, oscSetUserVar, promptLabel, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand } from "../../extensions/attention-notify/core.ts";

test("uses the Pi session name, falling back to the current directory basename", () => {
	assert.equal(sessionLabel("release prep", "/work/dotfiles"), "release prep");
	assert.equal(sessionLabel(undefined, "/work/dotfiles/"), "dotfiles");
	assert.equal(sessionLabel("   ", "/"), "session");
});

test("detects cmux from workspace, tab, or socket context", () => {
	assert.equal(isCmuxEnvironment({ CMUX_WORKSPACE_ID: "workspace-id" }), true);
	assert.equal(isCmuxEnvironment({ CMUX_TAB_ID: "tab-id" }), true);
	assert.equal(isCmuxEnvironment({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" }), true);
	assert.equal(isCmuxEnvironment({ TERM: "xterm-256color" }), false);
});

test("detects WezTerm directly or via its pane variable outside tmux", () => {
	assert.equal(isWezTermEnvironment({ TERM_PROGRAM: "WezTerm" }), true);
	assert.equal(isWezTermEnvironment({ WEZTERM_PANE: "3" }), true);
	assert.equal(isWezTermEnvironment({ WEZTERM_PANE: "3", TMUX: "/tmp/tmux" }), false);
	assert.equal(isWezTermEnvironment({ TERM_PROGRAM: "ghostty" }), false);
});

test("prefers cmux over WezTerm and returns nothing for other terminals", () => {
	assert.equal(resolveBackend({ CMUX_WORKSPACE_ID: "w", TERM_PROGRAM: "WezTerm" }), "cmux");
	assert.equal(resolveBackend({ TERM_PROGRAM: "WezTerm" }), "wezterm");
	assert.equal(resolveBackend({ TERM_PROGRAM: "ghostty" }), undefined);
});

test("builds an OSC 777 notification with separators and control characters neutralized", () => {
	assert.equal(osc777Notification("release prep: Ship?"), "\x1b]777;notify;Pi: Needs Input;release prep: Ship?\x1b\\");
	assert.equal(osc777Notification("a;b\x1b\x07c"), "\x1b]777;notify;Pi: Needs Input;a,b  c\x1b\\");
	assert.equal(osc777Notification("release prep", "Pi: Done"), "\x1b]777;notify;Pi: Done;release prep\x1b\\");
});

test("plays a system sound only on macOS", () => {
	assert.deepEqual(soundCommand("darwin"), ["osascript", ["-e", "beep"]]);
	assert.equal(soundCommand("linux"), undefined);
});

test("recognizes tools that block on user input", () => {
	assert.equal(isInputPromptTool("ask_user_question"), true);
	assert.equal(isInputPromptTool("bash"), false);
	assert.equal(isInputPromptTool(undefined), false);
});

test("appends the question to the prompt notification body", () => {
	assert.equal(promptLabel("release prep", { question: "Ship  today\nor tomorrow?" }), "release prep: Ship today or tomorrow?");
	assert.equal(promptLabel("release prep", { question: "   " }), "release prep");
	assert.equal(promptLabel("release prep", undefined), "release prep");
	const long = promptLabel("s", { question: "q".repeat(200) });
	assert.equal(long.length, 123);
	assert.ok(long.endsWith("…"));
});

test("uses the bundled cmux CLI when available and constructs concise notifications", () => {
	assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux" }), "/Applications/cmux.app/Contents/Resources/bin/cmux");
	assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "  " }), "cmux");
	assert.deepEqual(notificationArguments("release prep"), ["notify", "--title", "Pi: Needs Input", "--body", "release prep"]);
});

test("encodes attention state as a timestamped WezTerm user var", () => {
	assert.equal(attentionValue("done", 42), "done:42");
	assert.equal(attentionValue(undefined, 42), "");
	assert.equal(oscSetUserVar("pi_attention", "input:1"), "\x1b]1337;SetUserVar=pi_attention=aW5wdXQ6MQ==\x07");
});
