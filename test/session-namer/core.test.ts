import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPrompt,
	buildTranscript,
	DEFAULT_CONFIG,
	decideNaming,
	formatModelRef,
	parseConfig,
	parseModelRef,
	patchSettingsModel,
	readConfig,
	sanitizeName,
} from "../../extensions/session-namer/core.ts";

test("model refs parse provider/id and reject junk", () => {
	assert.deepEqual(parseModelRef(" anthropic/claude-haiku-4-5 "), { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.deepEqual(parseModelRef("openai-codex/gpt-5.4-mini"), { provider: "openai-codex", id: "gpt-5.4-mini" });
	assert.equal(parseModelRef("claude-haiku-4-5"), undefined);
	assert.equal(parseModelRef("/only-id"), undefined);
	assert.equal(parseModelRef("provider/"), undefined);
	assert.equal(parseModelRef("two words/id"), undefined);
	assert.equal(parseModelRef("  "), undefined);
});

test("model refs format back, with auto for unset", () => {
	assert.equal(formatModelRef({ provider: "anthropic", id: "claude-haiku-4-5" }), "anthropic/claude-haiku-4-5");
	assert.equal(formatModelRef(undefined), "auto");
});

test("patching the model keeps other settings and the extension's other keys", () => {
	const raw = JSON.stringify({ theme: "dark", "session-namer": { enabled: true, refreshEvery: 3 } }, null, 2);
	const patched = JSON.parse(patchSettingsModel(raw, { provider: "anthropic", id: "claude-haiku-4-5" }));
	assert.equal(patched.theme, "dark");
	assert.deepEqual(patched["session-namer"], {
		enabled: true,
		refreshEvery: 3,
		model: { provider: "anthropic", id: "claude-haiku-4-5" },
	});
});

test("patching preserves a configured thinking level from either shape", () => {
	const nested = JSON.parse(
		patchSettingsModel(JSON.stringify({ "session-namer": { model: { provider: "openai", id: "gpt-5.4-mini", thinking: "low" } } }), {
			provider: "anthropic",
			id: "claude-haiku-4-5",
		}),
	);
	assert.deepEqual(nested["session-namer"].model, { provider: "anthropic", id: "claude-haiku-4-5", thinking: "low" });

	const flat = JSON.parse(
		patchSettingsModel(JSON.stringify({ "session-namer": { provider: "openai", model: "gpt-5.4-mini", thinking: "medium" } }), {
			provider: "anthropic",
			id: "claude-haiku-4-5",
		}),
	);
	assert.deepEqual(flat["session-namer"].model, { provider: "anthropic", id: "claude-haiku-4-5", thinking: "medium" });
	assert.equal(flat["session-namer"].provider, undefined);
	assert.equal(flat["session-namer"].thinking, undefined);
});

test("patching with no ref clears the pin back to auto and round-trips through readConfig", () => {
	const cleared = patchSettingsModel(JSON.stringify({ "session-namer": { model: { provider: "openai", id: "gpt-5.4-mini" } } }), undefined);
	assert.deepEqual(JSON.parse(cleared)["session-namer"], {});
	assert.equal(readConfig(cleared).model, undefined);

	const pinned = patchSettingsModel("{}", { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.equal(readConfig(pinned).provider, "anthropic");
	assert.equal(readConfig(pinned).model, "claude-haiku-4-5");
});

test("patching refuses to clobber an unparseable settings file", () => {
	assert.throws(() => patchSettingsModel("{ not json", undefined), /not valid JSON/);
	assert.ok(patchSettingsModel("", undefined).endsWith("}\n"));
});

test("config defaults apply when the block is missing or malformed", () => {
	assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig("nope"), DEFAULT_CONFIG);
	assert.deepEqual(readConfig("{ not json"), DEFAULT_CONFIG);
	assert.deepEqual(readConfig("{}"), DEFAULT_CONFIG);
});

test("config reads a flat provider/model/thinking block", () => {
	const config = readConfig(
		JSON.stringify({ "session-namer": { provider: "anthropic", model: "claude-haiku-4-5", thinking: "off", refreshEvery: 3 } }),
	);
	assert.equal(config.provider, "anthropic");
	assert.equal(config.model, "claude-haiku-4-5");
	assert.equal(config.thinking, "off");
	assert.equal(config.refreshEvery, 3);
	assert.equal(config.enabled, true);
});

test("config reads a nested model object like observational-memory uses", () => {
	const config = parseConfig({ model: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "low" } });
	assert.equal(config.provider, "openai-codex");
	assert.equal(config.model, "gpt-5.6-luna");
	assert.equal(config.thinking, "low");
});

test("config rejects non-positive and non-numeric overrides", () => {
	const config = parseConfig({ refreshEvery: 0, maxNameLength: -4, maxTranscriptChars: "many" });
	assert.equal(config.refreshEvery, DEFAULT_CONFIG.refreshEvery);
	assert.equal(config.maxNameLength, DEFAULT_CONFIG.maxNameLength);
	assert.equal(config.maxTranscriptChars, DEFAULT_CONFIG.maxTranscriptChars);
});

test("config disables only on explicit false", () => {
	assert.equal(parseConfig({ enabled: false }).enabled, false);
	assert.equal(parseConfig({ enabled: true }).enabled, true);
	assert.equal(parseConfig({}).enabled, true);
});

test("sanitize strips quotes, labels, markdown and trailing punctuation", () => {
	assert.equal(sanitizeName('"Refactor Auth Module."', 60), "Refactor Auth Module");
	assert.equal(sanitizeName("Title: Fix Flaky Session Tests", 60), "Fix Flaky Session Tests");
	assert.equal(sanitizeName("**Migrate Dashboard Routes**", 60), "Migrate Dashboard Routes");
	assert.equal(sanitizeName("  Session:  Tidy   Sync Script  ", 60), "Tidy Sync Script");
});

test("sanitize takes the first non-empty line and drops empty results", () => {
	assert.equal(sanitizeName("\n\nAdd Retry To Uploads\nbecause reasons", 60), "Add Retry To Uploads");
	assert.equal(sanitizeName("", 60), undefined);
	assert.equal(sanitizeName('  "" ', 60), undefined);
	assert.equal(sanitizeName(undefined, 60), undefined);
});

test("sanitize truncates on a word boundary when possible", () => {
	assert.equal(sanitizeName("Migrate Questionnaires Dashboard Routes To Apps Api", 30), "Migrate Questionnaires");
	assert.equal(sanitizeName("Supercalifragilisticexpialidocious", 10), "Supercalif");
});

test("transcript keeps user and assistant text plus deduped tool names", () => {
	const transcript = buildTranscript(
		[
			{ type: "session" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "name my sessions" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "on it" },
						{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
						{ type: "toolCall", name: "bash", arguments: { command: "pwd" } },
						{ type: "toolCall", name: "read", arguments: {} },
					],
				},
			},
		],
		12000,
	);

	assert.equal(transcript, "User: name my sessions\n\nAssistant: on it\nTools used: bash, read");
});

test("transcript ignores non-message entries, other roles, and empty content", () => {
	assert.equal(
		buildTranscript(
			[
				{ type: "custom", customType: "session-namer" },
				{ type: "message", message: { role: "system", content: "ignore me" } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "   " }] } },
				{ type: "message", message: { role: "user", content: "string content" } },
				null,
			],
			12000,
		),
		"User: string content",
	);
});

test("transcript truncates the middle when over budget", () => {
	const entries = Array.from({ length: 50 }, (_, i) => ({
		type: "message",
		message: { role: "user", content: [{ type: "text", text: `message ${i} ${"x".repeat(200)}` }] },
	}));
	const transcript = buildTranscript(entries, 1000);

	assert.ok(transcript.length <= 1000 + "\n\n[...truncated...]\n\n".length);
	assert.ok(transcript.includes("[...truncated...]"));
	assert.ok(transcript.startsWith("User: message 0"));
	assert.ok(transcript.trimEnd().endsWith("x"));
});

test("prompt embeds the transcript and only mentions a current name when refreshing", () => {
	const fresh = buildPrompt("User: hi");
	assert.ok(fresh.includes("<conversation>\nUser: hi\n</conversation>"));
	assert.ok(!fresh.includes("current name"));

	const refresh = buildPrompt("User: hi", "Old Name");
	assert.ok(refresh.includes('The current name is "Old Name"'));
});

const base = {
	enabled: true,
	hasSession: true,
	manualName: false,
	settledSinceName: 0,
	refreshEvery: 5,
	inFlight: false,
};

test("names an unnamed session and refreshes only after the interval", () => {
	assert.equal(decideNaming(base), "generate");
	assert.equal(decideNaming({ ...base, currentName: "A Name", ownedName: "A Name", settledSinceName: 4 }), "skip");
	assert.equal(decideNaming({ ...base, currentName: "A Name", ownedName: "A Name", settledSinceName: 5 }), "refresh");
});

test("never touches a name the extension does not own", () => {
	assert.equal(decideNaming({ ...base, currentName: "Human Named", ownedName: "Auto Named", settledSinceName: 9 }), "skip");
	assert.equal(decideNaming({ ...base, currentName: "Human Named", settledSinceName: 9 }), "skip");
	assert.equal(decideNaming({ ...base, manualName: true }), "skip");
});

test("skips when disabled, ephemeral, or already generating", () => {
	assert.equal(decideNaming({ ...base, enabled: false }), "skip");
	assert.equal(decideNaming({ ...base, hasSession: false }), "skip");
	assert.equal(decideNaming({ ...base, inFlight: true }), "skip");
});
