import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "../../extensions/session-namer/index.ts";

const virtual = { provider: "router", id: "auto", api: "pi-virtual" };
const physical = { provider: "vendor", id: "small", api: "openai-responses" };
type FakeModel = typeof physical & { authenticated?: boolean };

function harness(config: Record<string, unknown> = {}, models: FakeModel[] = [], selected = virtual) {
	const original = fs.readFileSync;
	const settings = join(homedir(), ".pi", "agent", "settings.json");
	const read = test.mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => path === settings
		? JSON.stringify({ "session-namer": config })
		: original(path, options));
	syncBuiltinESMExports();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const entries: unknown[] = [{ type: "message", message: { role: "user", content: "Fix the widget" } }];
	const requests: { model: FakeModel; options: Record<string, unknown>; simple: boolean }[] = [];
	const notifications: string[] = [];
	let name: string | undefined;
	let failure = false;
	const response = () => {
		if (failure) throw new Error("fake runtime failure");
		return { content: [{ type: "text", text: "Widget Repair" }], stopReason: "stop" };
	};
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(event, handler); },
		registerCommand() {},
		getSessionName: () => name,
		setSessionName(value: string) { name = value; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const ctx = {
		hasUI: true, model: selected,
		ui: { notify(message: string) { notifications.push(message); } },
		sessionManager: { getSessionFile: () => "/fake/session", getEntries: () => entries, buildContextEntries: () => entries },
		modelRegistry: {
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: FakeModel) => model.authenticated !== false,
			complete(model: FakeModel, _context: unknown, options: Record<string, unknown>) {
				requests.push({ model, options, simple: false });
				if (model.api === "pi-virtual") throw new Error("Virtual model must be routed before streaming");
				return Promise.resolve(response());
			},
			streamSimple(model: FakeModel, _context: unknown, options: Record<string, unknown>) {
				requests.push({ model, options, simple: true });
				return { result: async () => response() };
			},
		},
	};
	try { register(pi as unknown as ExtensionAPI); } catch (error) { read.mock.restore(); syncBuiltinESMExports(); throw error; }
	return {
		requests, entries, notifications,
		name: () => name,
		setManualName(value: string) { name = value; },
		fail() { failure = true; },
		emit: (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx as unknown as ExtensionContext),
		close() { read.mock.restore(); syncBuiltinESMExports(); },
	};
}

test("selected virtual naming model routes with provider-neutral thinking and owns the generated name", async () => {
	const h = harness({ thinking: "high" });
	try {
		await h.emit("session_start");
		await h.emit("agent_settled");
		assert.equal(h.name(), "Widget Repair");
		assert.equal(h.requests[0].simple, true);
		assert.equal(h.requests[0].options.reasoning, "high");
		assert.equal(h.requests[0].options.cacheRetention, "none");
		assert.ok(h.requests[0].options.sessionId);
		assert.deepEqual(h.entries.at(-1), { type: "custom", customType: "session-namer", data: { name: "Widget Repair" } });
	} finally { h.close(); }
});

for (const source of ["pinned", "fallback"] as const) {
	test(`${source} virtual naming model routes without using provider-specific options`, async () => {
		const model = source === "pinned" ? virtual : { ...virtual, provider: "openai-codex", id: "gpt-5.6-luna" };
		const h = harness(source === "pinned" ? { provider: model.provider, model: model.id, thinking: "low" } : {}, [model], physical);
		try {
			await h.emit("agent_settled");
			assert.equal(h.name(), "Widget Repair");
			assert.deepEqual(h.requests[0].model, model);
			assert.equal(h.requests[0].simple, true);
			assert.equal(h.requests[0].options.reasoning, source === "pinned" ? "low" : undefined);
			assert.equal(h.requests[0].options.reasoningEffort, undefined);
		} finally { h.close(); }
	});
}

for (const [api, thinking, expected] of [
	["openai-responses", undefined, { reasoningEffort: "minimal" }],
	["openai-codex-responses", "off", { reasoningEffort: "none" }],
	["openai-responses", "high", { reasoningEffort: "high" }],
	["anthropic-messages", "minimal", { thinkingEnabled: true, thinkingEffort: "low" }],
	["anthropic-messages", "off", {}],
] as const) {
	test(`physical naming preserves ${api}/${thinking ?? "default"} options`, async () => {
		const h = harness({ thinking }, [], { ...physical, api });
		try {
			await h.emit("agent_settled");
			assert.equal(h.name(), "Widget Repair");
			const { sessionId, cacheRetention, ...options } = h.requests[0].options;
			assert.ok(sessionId);
			assert.equal(cacheRetention, "none");
			assert.deepEqual(options, expected);
			assert.equal(h.requests[0].simple, false);
		} finally { h.close(); }
	});
}

test("unavailable pinned auth falls back, warns once, and preserves manual ownership", async () => {
	const h = harness({ provider: "router", model: "auto", refreshEvery: 1 }, [{ ...virtual, authenticated: false }], physical);
	try {
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		assert.equal(h.requests.length, 2);
		assert.equal(h.requests[0].model, physical);
		assert.equal(h.notifications.filter(message => message.includes("unavailable")).length, 1);
		h.setManualName("Human Name");
		await h.emit("session_info_changed", { name: "Human Name" });
		await h.emit("agent_settled");
		assert.equal(h.name(), "Human Name");
		assert.equal(h.requests.length, 2);
	} finally { h.close(); }
});

test("virtual runtime failures leave naming retryable without taking ownership", async () => {
	const h = harness({ notify: true });
	try {
		h.fail();
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		assert.equal(h.name(), undefined);
		assert.equal(h.entries.length, 1);
		assert.equal(h.requests.length, 2);
		assert.ok(h.notifications.every(message => message.includes("fake runtime failure")));
	} finally { h.close(); }
});
