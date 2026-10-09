import assert from "node:assert/strict";
import test from "node:test";
import { attentionDirectory, attentionFileName, attentionValue, isCmuxEnvironment, isInputPromptTool, isWezTermEnvironment, notificationArguments, oscSetUserVar, promptLabel, questionText, resolveBackend, resolveCmuxCli, sessionLabel, soundCommand, weztermPane } from "../../extensions/attention-notify/core.ts";

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

test("locates attention records per WezTerm pane, falling back to the process id", () => {
	assert.equal(attentionDirectory({}, "/home/me"), "/home/me/.pi/agent/attention");
	assert.equal(attentionDirectory({ PI_ATTENTION_DIR: "/tmp/attention" }, "/home/me"), "/tmp/attention");
	assert.equal(weztermPane({ TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "12" }), 12);
	assert.equal(weztermPane({ WEZTERM_PANE: "12", TMUX: "/tmp/tmux" }), undefined);
	assert.equal(weztermPane({ TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "x" }), undefined);
	assert.equal(attentionFileName({ TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "12" }, 99), "pane-12.json");
	assert.equal(attentionFileName({}, 99), "pid-99.json");
});

test("extracts the collapsed question text", () => {
	assert.equal(questionText({ question: " Ship\n it? " }), "Ship it?");
	assert.equal(questionText({ question: "" }), undefined);
	assert.equal(questionText(undefined), undefined);
});
