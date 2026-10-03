import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import register from "../../extensions/usage/index.ts";
import { availableProviderIds } from "../../extensions/usage/providers.ts";

const chatGPTCredential: Credential = {
	type: "oauth", access: "fake-direct-chatgpt-token", refresh: "fake-refresh", expires: Date.now() + 3_600_000,
	clientId: "fake-client", scopes: ["chatgpt.tokens.use.direct"],
};
const codexCredential: Credential = {
	type: "oauth", access: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account-runtime" } })).toString("base64url")}.signature`,
	refresh: "fake-codex-refresh", expires: Date.now() + 3_600_000,
};

async function context(provider: string, credentials: Record<string, Credential>) {
	const store = new InMemoryCredentialStore();
	for (const [id, credential] of Object.entries({ openai: { type: "api_key", key: "" } as Credential, ...credentials })) {
		await store.modify(id, async () => credential);
	}
	const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
	for (const candidate of runtime.getProviders()) {
		if (!await store.read(candidate.id)) await store.modify(candidate.id, async () => ({ type: "api_key", key: "" }));
	}
	await runtime.getAvailable();
	const notifications: { text: string; level: string }[] = [];
	return {
		runtime, store, notifications,
		ctx: {
			mode: "print", model: { provider }, modelRegistry: new ModelRegistry(runtime),
			ui: { notify(text: string, level: string) { notifications.push({ text, level }); } },
		} as unknown as ExtensionCommandContext,
	};
}

function command() {
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("Command not registered"); };
	register({ registerCommand(name, definition) {
		assert.equal(name, "usage");
		handler = definition.handler;
	} } as ExtensionAPI);
	return handler;
}

function quotaResponse() {
	return Response.json({ plan_type: "synthetic_standard", rate_limit: { primary_window: { used_percent: 31 } } });
}

function modalViews(ctx: ExtensionCommandContext, steps: { select: number; before?: () => Promise<unknown> }[]) {
	const views: string[] = [];
	ctx.mode = "tui";
	ctx.ui.custom = async <T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>) => {
		const step = steps.shift();
		assert.ok(step, "Unexpected usage modal");
		let result: T | undefined;
		const component = await factory(
			{ terminal: { rows: 100 }, requestRender() {} } as never,
			{ fg: (_color: string, value: string) => value, bold: (value: string) => value } as never,
			{} as never, (value) => { result = value; },
		);
		views.push(component.render(120).join("\n"));
		await step.before?.();
		if (step.select < 0) component.handleInput?.("\x1b");
		else {
			for (let index = 0; index < step.select; index++) component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
		}
		assert.notEqual(result, undefined, "Usage modal did not finish");
		return result as T;
	};
	return views;
}

test("usage routes opaque OpenAI ChatGPT OAuth to its own dashboard without sending it to Codex", async () => {
	const { ctx, notifications } = await context("openai", { openai: chatGPTCredential });
	const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("No subscription endpoint verified for direct tokens"); });
	try {
		await command()("", ctx);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warning");
		assert.match(notifications[0].text, /ChatGPT subscription usage/);
		assert.match(notifications[0].text, /https:\/\/chatgpt.com\/settings\/usage/);
		assert.match(notifications[0].text, /Live quota.*unavailable/);
		assert.doesNotMatch(notifications[0].text, /Codex subscription quota|fake-direct|fake-refresh/);
		assert.equal(fetchMock.mock.callCount(), 0);
		assert.deepEqual(await availableProviderIds(ctx), ["openai"]);
	} finally {
		fetchMock.mock.restore();
	}
});

test("dual subscription logins stay provider-specific and the fallback lists each distinct quota view once", async () => {
	for (const provider of ["openai", "openai-codex", "google"]) {
		const { ctx, notifications } = await context(provider, { openai: chatGPTCredential, "openai-codex": codexCredential });
		const fetchMock = mock.method(globalThis, "fetch", async () => quotaResponse());
		try {
			await command()("", ctx);
			const text = notifications[0].text;
			assert.equal(text.split("◆ ChatGPT subscription usage").length - 1, provider === "openai-codex" ? 0 : 1);
			assert.equal(text.split("◆ Codex subscription quota").length - 1, provider === "openai" ? 0 : 1);
			assert.equal(fetchMock.mock.callCount(), provider === "openai" ? 0 : 1);
			assert.doesNotMatch(text, /fake-direct|fake-refresh|synthetic-account-runtime|header\./);
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("OpenAI API-key-only and missing auth never request subscription quota", async () => {
	for (const credentials of [{ openai: { type: "api_key", key: "fake-api-key" } as Credential }, {}]) {
		const { ctx, notifications } = await context("openai", credentials);
		const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Subscription request forbidden"); });
		try {
			await command()("", ctx);
			assert.match(notifications[0].text, /No Claude, ChatGPT, or Codex subscription login found/);
			assert.equal(notifications[0].level, "warning");
			assert.equal(fetchMock.mock.callCount(), 0);
			assert.deepEqual(await availableProviderIds(ctx), []);
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("OpenAI auth rechecks resolved source after credentials change or a runtime API key overrides OAuth", async () => {
	const { ctx, runtime, store } = await context("openai", { openai: chatGPTCredential });
	assert.deepEqual(await availableProviderIds(ctx), ["openai"]);
	assert.ok(await ctx.modelRegistry.getApiKeyForProvider("openai") === chatGPTCredential.access);
	await runtime.setRuntimeApiKey("openai", "fake-runtime-key");
	assert.deepEqual(await availableProviderIds(ctx), []);
	await runtime.removeRuntimeApiKey("openai");
	assert.deepEqual(await availableProviderIds(ctx), ["openai"]);
	await store.modify("openai", async () => ({ type: "api_key", key: "fake-replacement-key" }));
	assert.equal(ctx.modelRegistry.isUsingOAuth({ provider: "openai" } as never), true);
	assert.deepEqual(await availableProviderIds(ctx), []);
});

test("ChatGPT token refresh remains runtime-owned and failures stay secret-safe", async () => {
	const { ctx, store, notifications } = await context("openai", { openai: chatGPTCredential });
	await store.modify("openai", async () => ({ ...chatGPTCredential, expires: 1 }));
	const requests: string[] = [];
	const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return Response.json({ access_token: "fake-refreshed-direct-token", refresh_token: "fake-rotated-refresh", expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
	});
	try {
		await command()("", ctx);
		assert.deepEqual(requests, ["https://auth.openai.com/api/accounts/oauth/token"]);
		assert.ok(await ctx.modelRegistry.getApiKeyForProvider("openai") === "fake-refreshed-direct-token");
		assert.match(notifications[0].text, /ChatGPT subscription usage/);
		assert.doesNotMatch(notifications[0].text, /fake-refreshed|fake-rotated/);
		await store.modify("openai", async () => ({ ...chatGPTCredential, expires: 1 }));
		fetchMock.mock.mockImplementation(async () => { throw new Error("fake-secret-in-refresh-error"); });
		await command()("", ctx);
		assert.doesNotMatch(notifications[1].text, /fake-secret|fake-refresh|fake-direct/);
		assert.equal(notifications[1].level, "warning");
	} finally {
		fetchMock.mock.restore();
	}
});

test("refresh discovers ChatGPT after an active OpenAI API key or missing login upgrades to OAuth", async () => {
	for (const credentials of [{ openai: { type: "api_key", key: "fake-api-key" } as Credential }, {}]) {
		const { ctx, store } = await context("openai", credentials);
		const views = modalViews(ctx, [
			{ select: 0, before: () => store.modify("openai", async () => chatGPTCredential) },
			{ select: -1 },
		]);
		const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Subscription request forbidden"); });
		try {
			await command()("", ctx);
			assert.equal(views.length, 2);
			assert.match(views[0], /No Claude, ChatGPT, or Codex subscription login found/);
			assert.match(views[1], /ChatGPT subscription usage/);
			assert.match(views[1], /Live quota is unavailable/);
			assert.doesNotMatch(views[1], /No Claude, ChatGPT, or Codex subscription login found/);
			assert.equal(fetchMock.mock.callCount(), 0);
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("an explicit all-providers choice follows auth downgrades and upgrades without reverting to the active provider", async () => {
	for (const provider of ["openai", "openai-codex"]) {
		const { ctx, store } = await context(provider, { openai: chatGPTCredential, "openai-codex": codexCredential });
		const views = modalViews(ctx, [
			{ select: 2 },
			{ select: 0, before: () => store.modify("openai", async () => ({ type: "api_key", key: "fake-switched-key" })) },
			{ select: 0, before: () => store.modify("openai", async () => chatGPTCredential) },
			{ select: 0 },
			{ select: -1 },
		]);
		const fetchMock = mock.method(globalThis, "fetch", async () => quotaResponse());
		try {
			await command()("", ctx);
			assert.equal(views.length, 5);
			assert.match(views[2], /Codex subscription quota/);
			assert.doesNotMatch(views[2], /ChatGPT subscription usage|Open ChatGPT dashboard/);
			for (const view of [views[1], views[3], views[4]]) {
				assert.equal(view.split("◆ ChatGPT subscription usage").length - 1, 1);
				assert.equal(view.split("◆ Codex subscription quota").length - 1, 1);
			}
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("refresh reconciles automatic Codex fallbacks and dual auth with the active provider", async () => {
	for (const provider of ["openai", "openai-codex", "google"]) {
		const { ctx, store } = await context(provider, { "openai-codex": codexCredential });
		const views = modalViews(ctx, [
			{ select: 0, before: () => store.modify("openai", async () => chatGPTCredential) },
			{ select: 0, before: () => store.modify("openai", async () => ({ type: "api_key", key: "fake-switched-key" })) },
			{ select: -1 },
		]);
		const fetchMock = mock.method(globalThis, "fetch", async () => quotaResponse());
		try {
			await command()("", ctx);
			assert.equal(views.length, 3);
			assert.match(views[0], /Codex subscription quota/);
			assert.doesNotMatch(views[0], /ChatGPT subscription usage/);
			assert.equal(views[1].split("◆ ChatGPT subscription usage").length - 1, provider === "openai-codex" ? 0 : 1);
			assert.equal(views[1].split("◆ Codex subscription quota").length - 1, provider === "openai" ? 0 : 1);
			assert.match(views[2], /Codex subscription quota/);
			assert.doesNotMatch(views[2], /ChatGPT subscription usage|Open ChatGPT dashboard|Show ChatGPT only/);
			for (const view of views) assert.doesNotMatch(view, /fake-direct|fake-refresh|synthetic-account-runtime|fake-switched|header\./);
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("refresh preserves an explicit provider-only choice through auth changes", async () => {
	for (const provider of ["openai", "openai-codex"]) {
		const { ctx, store } = await context(provider, { openai: chatGPTCredential, "openai-codex": codexCredential });
		const views = modalViews(ctx, [
			{ select: 2 },
			{ select: 3 },
			{ select: 0, before: () => store.modify("openai", async () => ({ type: "api_key", key: "fake-switched-key" })) },
			{ select: 0, before: () => store.modify("openai", async () => chatGPTCredential) },
			{ select: -1 },
		]);
		const fetchMock = mock.method(globalThis, "fetch", async () => quotaResponse());
		try {
			await command()("", ctx);
			assert.equal(views.length, 5);
			for (const view of [views[2], views[3], views[4]]) {
				assert.equal(view.split("◆ ChatGPT subscription usage").length - 1, provider === "openai" ? 1 : 0);
				assert.equal(view.split("◆ Codex subscription quota").length - 1, provider === "openai-codex" ? 1 : 0);
			}
			if (provider === "openai") {
				assert.match(views[3], /Sign in with ChatGPT/);
				assert.doesNotMatch(views[3], /Live quota is unavailable/);
				assert.match(views[4], /Live quota is unavailable/);
				assert.doesNotMatch(views[4], /Sign in with ChatGPT/);
			}
		} finally {
			fetchMock.mock.restore();
		}
	}
});

test("refresh stops showing ChatGPT subscription scope when OpenAI switches to API-key auth", async () => {
	const { ctx, store } = await context("openai", { openai: chatGPTCredential, "openai-codex": codexCredential });
	const views = modalViews(ctx, [
		{ select: 0, before: () => store.modify("openai", async () => ({ type: "api_key", key: "fake-switched-key" })) },
		{ select: -1 },
	]);
	const fetchMock = mock.method(globalThis, "fetch", async () => quotaResponse());
	try {
		await command()("", ctx);
		assert.equal(views.length, 2);
		assert.match(views[0], /ChatGPT subscription usage/);
		assert.match(views[1], /Codex subscription quota/);
		assert.doesNotMatch(views[1], /ChatGPT subscription usage|Show ChatGPT only/);
	} finally {
		fetchMock.mock.restore();
	}
});

test("an active OpenAI API key falls back to authenticated legacy Codex, never to ChatGPT subscription auth", async () => {
	const { ctx, notifications } = await context("openai", {
		openai: { type: "api_key", key: codexCredential.access }, "openai-codex": codexCredential,
	});
	const requests: string[] = [];
	const fetchMock = mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
		requests.push(url);
		const headers = new Headers(options.headers);
		assert.ok(headers.get("Authorization") === `Bearer ${codexCredential.access}`);
		assert.ok(headers.get("ChatGPT-Account-Id") === "synthetic-account-runtime");
		return quotaResponse();
	});
	try {
		await command()("", ctx);
		assert.match(notifications[0].text, /Codex subscription quota.*Synthetic standard plan/);
		assert.match(notifications[0].text, /31% used/);
		assert.doesNotMatch(notifications[0].text, /ChatGPT subscription usage/);
		assert.equal(notifications[0].level, "info");
		assert.deepEqual(requests, ["https://chatgpt.com/backend-api/wham/usage"]);
		assert.deepEqual(await availableProviderIds(ctx), ["openai-codex"]);
	} finally {
		fetchMock.mock.restore();
	}
});
