import assert from "node:assert/strict";
import test from "node:test";
import { isCmuxEnvironment, isInputPromptTool, notificationArguments, promptLabel, resolveCmuxCli, sessionLabel } from "../../extensions/cmux-notify/core.ts";

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
