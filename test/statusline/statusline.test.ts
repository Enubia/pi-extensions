import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import register from "../../extensions/statusline.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
test.before(() => { process.env.PI_CODING_AGENT_DIR = "/nonexistent-statusline-fixture"; });
test.after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const virtual = { provider: "router", id: "auto", api: "pi-virtual", contextWindow: 1_000_000 };
const physical = { provider: "vendor", id: "small", api: "openai-responses", contextWindow: 128_000 };
const dispatch = (id = "small", thinkingLevel: string | undefined = "medium", stopReason = "stop", api = "openai-responses") => ({
	type: "message", message: { role: "assistant", provider: "vendor", model: id, api, thinkingLevel, stopReason },
});

async function harness(selected = virtual) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	let footer: { render: (width: number) => string[] } = { render() { throw new Error("Footer not installed"); } };
	let branch: unknown[] = [dispatch()];
	let model = selected;
	let thinkingLevel = "high";
	let renders = 0;
	const ctx = {
		cwd: "/nonexistent", get model() { return model; }, get thinkingLevel() { return thinkingLevel; },
		getContextUsage: () => ({ tokens: 32_000, percent: 25, contextWindow: 128_000 }),
		sessionManager: { getSessionId: () => "fake-session", getBranch: () => branch, getEntries: () => [dispatch("abandoned")] },
		ui: {
			setFooter(factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) {
				footer = factory({ requestRender() { renders++; } }, { fg: (_color: string, text: string) => text }, {
					getExtensionStatuses: () => new Map([[" bash-guard", "guard"], ["provider-failover", "fallback"], ["pi-automode", "●"]]),
				});
			}, notify() {},
		},
	};
	register({
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) { handlers.set(event, handler); },
		registerCommand() {}, getThinkingLevel: () => "low", getSessionName: () => "Widget Repair",
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({}, ctx);
	return {
		render: (width = 240) => footer.render(width).map(line => line.replace(/\x1b\[[0-9;]*m/g, "")),
		renders: () => renders,
		setBranch(value: unknown[]) { branch = value; },
		select(value: typeof virtual, level = "high") { model = value; thinkingLevel = level; },
		emit: (event: string) => handlers.get(event)?.({}, ctx),
	};
}

test("virtual footer ignores stale pi-automode while retaining thinking, usage, other badges and name", async () => {
	const h = await harness();
	const rows = h.render();
	assert.match(rows[0], /router\/auto \(128k context\) \[high\] → vendor\/small \[medium\]/);
	assert.match(rows[0], /32\.0k \(25\.0%\).*guard.*fallback/);
	assert.doesNotMatch(rows[0], /automode|●/);
	assert.match(rows[1], /Widget Repair/);
	assert.doesNotMatch(rows.join("\n"), /abandoned/);
	for (const width of [20, 80, 240]) assert.ok(h.render(width).every(line => visibleWidth(line) <= width));
});

test("tree navigation reads only the active branch and drops dispatch when no physical response remains", async () => {
	const h = await harness();
	h.setBranch([dispatch("branch-b", "off"), dispatch("failed", "high", "error"), dispatch("cancelled", "high", "aborted"), dispatch("unrouted", "low", "error", "pi-virtual")]);
	await h.emit("session_tree");
	assert.match(h.render()[0], /→ vendor\/branch-b \[off\]/);
	assert.doesNotMatch(h.render()[0], /small|failed|cancelled|unrouted|abandoned/);
	assert.ok(h.renders() > 0);
	h.setBranch([{ type: "model_change", provider: "router", modelId: "auto" }]);
	await h.emit("session_tree");
	assert.doesNotMatch(h.render()[0], /→|branch-b|abandoned/);
});

test("legacy physical dispatch does not borrow selected thinking", async () => {
	const h = await harness();
	h.setBranch([{ type: "message", message: { role: "assistant", provider: "vendor", model: "legacy", stopReason: "stop" } }]);
	assert.match(h.render()[0], /\[high\] → vendor\/legacy \|/);
});

test("physical-only footer preserves model/context/thinking and hides historical dispatch", async () => {
	const h = await harness(physical);
	h.select(physical, "low");
	assert.equal(h.render()[0], "vendor/small (128k context) [low] | 32.0k (25.0%) | guard | fallback");
	h.select(physical, "off");
	await h.emit("model_select");
	assert.equal(h.render()[0], "vendor/small (128k context) | 32.0k (25.0%) | guard | fallback");
	h.select(virtual, "off");
	await h.emit("model_select");
	assert.match(h.render()[0], /router\/auto .*\[off\] → vendor\/small \[medium\]/);
});
