import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import register from "../../extensions/provider-failover/index.ts";

async function harness(options: { nativeRetry?: boolean; failoverRetry?: boolean; fallback?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "provider-failover-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let dispose: (() => void) | undefined;
	const close = () => {
		dispose?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	};
	try {
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(modelRuntime);
		const origin = registry.getAll().find(model => model.provider === "openai" && model.id === "gpt-4o");
		const fallback = registry.getAll().find(model => model.provider === "anthropic");
		assert.ok(origin);
		assert.ok(fallback);
		await modelRuntime.setRuntimeApiKey(origin.provider, "synthetic-origin-key");
		if (options.fallback !== false) await modelRuntime.setRuntimeApiKey(fallback.provider, "synthetic-fallback-key");
		writeFileSync(join(agentDir, "subagent-models.json"), JSON.stringify({
			fallbackProfile: "origin",
			profiles: {
				origin: { providers: [origin.provider], defaultTier: "standard", tiers: { standard: { model: `${origin.provider}/${origin.id}` } } },
				fallback: { providers: [fallback.provider], defaultTier: "standard", tiers: { standard: { model: `${fallback.provider}/${fallback.id}` } } },
			},
		}));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "provider-failover": { retry: options.failoverRetry ?? true } }));
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: options.nativeRetry ?? true, maxRetries: 1, baseDelayMs: 1 },
			compaction: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager, extensionFactories: [register],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: root, agentDir, resourceLoader, modelRuntime, model: origin,
			settingsManager, sessionManager: SessionManager.inMemory(), tools: [],
		});
		dispose = () => session.dispose();
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: error => errors.push(error) });
		const requests: string[] = [];
		const retries: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retries.push(session.model!.provider);
		});
		return {
			session, origin, fallback, requests, retries, errors, close,
			state: () => existsSync(join(agentDir, "provider-failover-state.json"))
				? JSON.parse(readFileSync(join(agentDir, "provider-failover-state.json"), "utf8"))
				: { cooldowns: {} },
			respond(failure: (provider: string, attempt: number) => string | undefined) {
				session.agent.streamFunction = model => {
					requests.push(model.provider);
					const errorMessage = failure(model.provider, requests.length);
					const message: AssistantMessage = {
						role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
						content: errorMessage ? [] : [{ type: "text", text: "Done." }],
						stopReason: errorMessage ? "error" : "stop", ...(errorMessage ? { errorMessage } : {}),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					const stream = createAssistantMessageEventStream();
					if (errorMessage) stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
					return stream;
				};
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

const capacity = "Selected model is at capacity";

test("native capacity retry succeeds without switching providers or queuing a duplicate continuation", async () => {
	const h = await harness();
	try {
		h.respond((_provider, attempt) => attempt === 1 ? capacity : undefined);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider, h.origin.provider]);
		assert.deepEqual(h.retries, [h.origin.provider]);
		assert.equal(h.session.model?.provider, h.origin.provider);
		assert.deepEqual(h.state().cooldowns, {});
		assert.equal(h.session.messages.filter(message => message.role === "user").length, 1);
	} finally { h.close(); }
});

for (const nativeRetry of [true, false]) test(`failover continues exactly once after native retries ${nativeRetry ? "exhaust" : "are disabled"}`, async () => {
	const h = await harness({ nativeRetry });
	try {
		h.respond(provider => provider === h.origin.provider ? capacity : undefined);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [...Array(nativeRetry ? 2 : 1).fill(h.origin.provider), h.fallback.provider]);
		assert.equal(h.session.model?.provider, h.fallback.provider);
		assert.equal(h.state().cooldowns[h.origin.provider].kind, "transient");
		assert.equal(h.session.messages.filter(message => message.role === "user").length, 2);
	} finally { h.close(); }
});

test("aborting native retry does not switch providers or continue the task", async () => {
	const h = await harness();
	try {
		h.respond(() => capacity);
		h.session.subscribe(event => {
			if (event.type === "auto_retry_start") void h.session.abort();
		});
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider]);
		assert.equal(h.session.model?.provider, h.origin.provider);
		assert.deepEqual(h.state().cooldowns, {});
	} finally { h.close(); }
});

test("failover retry off still switches after exhaustion without another request", async () => {
	const h = await harness({ failoverRetry: false });
	try {
		h.respond(() => capacity);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider, h.origin.provider]);
		assert.equal(h.session.model?.provider, h.fallback.provider);
	} finally { h.close(); }
});

for (const failure of ["insufficient_quota", "model not_found"]) test(`non-retryable ${failure} still fails over`, async () => {
	const h = await harness();
	try {
		h.respond(provider => provider === h.origin.provider ? failure : undefined);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider, h.fallback.provider]);
		assert.equal(h.session.model?.provider, h.fallback.provider);
	} finally { h.close(); }
});

test("failure on every provider exhausts each retry budget without a continuation loop", async () => {
	const h = await harness();
	try {
		h.respond(() => capacity);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider, h.origin.provider, h.fallback.provider, h.fallback.provider]);
		assert.deepEqual(Object.keys(h.state().cooldowns).sort(), [h.origin.provider, h.fallback.provider].sort());
	} finally { h.close(); }
});

test("exhaustion without an authenticated fallback settles without a continuation loop", async () => {
	const h = await harness({ fallback: false });
	try {
		h.respond(() => capacity);
		await h.session.prompt("Synthetic task");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(h.requests, [h.origin.provider, h.origin.provider]);
		assert.equal(h.session.model?.provider, h.origin.provider);
	} finally { h.close(); }
});
