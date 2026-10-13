import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { registerCacheAwareCompaction } from "../../extensions/observational-memory/src/hooks/cache-aware-compaction.js";
import { DEFAULTS } from "../../extensions/observational-memory/src/config.js";
import { Runtime } from "../../extensions/observational-memory/src/runtime.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

function reply(model: { api: string; provider: string; id: string }): ReturnType<typeof createAssistantMessageEventStream> {
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
		content: [{ type: "text", text: "Done. ".repeat(200) }], stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

async function harness() {
	const root = mkdtempSync(join(tmpdir(), "om-cache-aware-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let dispose: (() => void) | undefined;
	cleanups.push(() => {
		dispose?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const model = new ModelRegistry(modelRuntime).getAll().find(candidate => candidate.provider === "openai" && candidate.id === "gpt-4o");
	if (!model) throw new Error("gpt-4o is not in the built-in catalog");
	await modelRuntime.setRuntimeApiKey(model.provider, "synthetic-key");

	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		compactAfterTokensMode: "calibrated",
		compactAfterTokens: 1_000,
		cacheAwareCompaction: { ...DEFAULTS.cacheAwareCompaction, softFraction: 0.1 },
	};
	const compactions: string[] = [];
	const extension = (pi: ExtensionAPI) => {
		registerCacheAwareCompaction(pi, runtime);
		pi.on("session_before_compact", async (event) => ({
			compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
		}));
		pi.on("session_compact", async () => {
			compactions.push("compacted");
		});
	};

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } as never });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, extensionFactories: [extension],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root, agentDir, resourceLoader, modelRuntime, model,
		settingsManager, sessionManager: SessionManager.inMemory(), tools: [],
	});
	dispose = () => session.dispose();
	const ui = { notify: () => {} } as unknown as ExtensionUIContext;
	await session.bindExtensions({ uiContext: ui, mode: "tui" } as never);
	const requests: string[] = [];
	session.agent.streamFunction = (requestModel, context) => {
		const last = context.messages.at(-1);
		requests.push(last?.role === "user" ? JSON.stringify(last.content) : String(last?.role));
		return reply(requestModel);
	};
	return { session, runtime, requests, compactions };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
	return Promise.race([promise, new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms))]);
}

describe("cache-aware compaction in a live session", () => {
	it("compacts before a cold-cache prompt and still sends that prompt", async () => {
		const { session, runtime, requests, compactions } = await harness();
		await session.prompt(`first ${"x ".repeat(2_000)}`);
		expect(requests).toHaveLength(1);

		runtime.cacheColdReason = "model-change";
		const outcome = await within(session.prompt("second prompt"), 3_000);

		expect(outcome).not.toBe("timeout");
		expect(compactions).toEqual(["compacted"]);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("second prompt");
		expect(runtime.compactInFlight).toBe(false);
	});
});
