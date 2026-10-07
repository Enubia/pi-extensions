import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../extensions/observational-memory/src/config.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../../extensions/observational-memory/src/hooks/consolidation-trigger.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";
import type { Entry } from "../../extensions/observational-memory/src/session-ledger/index.js";
import { observationsRecordedEntry, observation } from "./fixtures.js";

const model = getBuiltinModel("openai", "gpt-4o");

function entries(): Entry[] {
	const stamp = 1_700_000_000_000;
	return [
		{ type: "message", id: "old", message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: stamp } },
		{
			type: "message",
			id: "call-entry",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a/skills/x/SKILL.md" } }], timestamp: stamp },
		},
		observationsRecordedEntry([observation(1, ["old"])], "call-entry"),
		{ type: "message", id: "res-1", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "SKILL BODY SECRET" }], timestamp: stamp } },
		{ type: "message", id: "res-2", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "dup output" }], timestamp: stamp } },
		{ type: "message", id: "res-3", message: { role: "toolResult", toolCallId: "c3", toolName: "bash", content: [{ type: "text", text: "dup output" }], timestamp: stamp } },
	];
}

async function observerInput(config: Partial<Runtime["config"]>): Promise<string> {
	const branch = entries();
	const prompts: string[] = [];
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1, reflectAfterTokens: 1_000_000, showWorkerNotifications: false, ...config };
	const ctx: ConsolidationCtx = {
		cwd: "/nonexistent",
		hasUI: false,
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			streamSimple: (_model: unknown, context: Context) => {
				prompts.push(JSON.stringify(context.messages));
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
					content: [{ type: "text", text: "Done." }], stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		},
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => "s" },
	};
	const pi = { appendEntry: () => undefined } as unknown as ExtensionAPI;
	await runConsolidationPipeline(pi, runtime, ctx, true);
	return prompts.join("\n");
}

describe("observer stage redaction wiring", () => {
	it("redacts skill reads using a call that precedes the backlog and collapses duplicates", async () => {
		const input = await observerInput({});
		expect(input).not.toContain("SKILL BODY SECRET");
		expect(input).toContain("[skill file /a/skills/x/SKILL.md loaded; content omitted]");
		expect(input).toContain("[identical to source entry res-2]");
	});

	it("sends raw content when both flags are off", async () => {
		const input = await observerInput({ observerRedactSkillReads: false, observerDedupeToolResults: false });
		expect(input).toContain("SKILL BODY SECRET");
		expect(input).not.toContain("identical to source entry");
	});
});
