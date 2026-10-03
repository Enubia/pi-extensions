import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, noProvidersText, providerFor, resolveScope, USAGE_PROVIDERS, usageMenu } from "../../extensions/usage/providers.ts";

test("scopes usage to the current model provider when it reports subscription quota", () => {
	const claudeScope = resolveScope("anthropic", ["anthropic", "openai-codex"]);
	assert.equal(claudeScope.kind, "provider");
	assert.deepEqual(claudeScope.providers.map((provider) => provider.id), ["anthropic"]);

	const codexScope = resolveScope("openai-codex", []);
	assert.equal(codexScope.kind, "provider");
	assert.deepEqual(codexScope.providers.map((provider) => provider.id), ["openai-codex"]);
});

test("falls back to every authenticated provider for models without subscription quota", () => {
	assert.deepEqual(
		resolveScope("google", ["openai-codex", "anthropic"]).providers.map((provider) => provider.id),
		["anthropic", "openai-codex"],
	);
	assert.deepEqual(resolveScope(undefined, ["openai-codex"]).providers.map((provider) => provider.id), ["openai-codex"]);
	assert.deepEqual(resolveScope("openrouter", []).providers, []);
	assert.equal(providerFor("openrouter"), undefined);
	assert.match(noProvidersText(), /No Claude, ChatGPT, or Codex subscription login found\./);
	assert.match(noProvidersText(), /anthropic, openai, or openai-codex/);
});

test("offers refresh, per-provider dashboards, and scope switches that match availability", () => {
	const focused = usageMenu(resolveScope("anthropic", ["anthropic", "openai-codex"]), "anthropic", ["anthropic", "openai-codex"]);
	assert.deepEqual(focused.map((item) => item.value), ["refresh", "dashboard:anthropic", "all", "close"]);

	const onlyLogin = usageMenu(resolveScope("anthropic", ["anthropic"]), "anthropic", ["anthropic"]);
	assert.deepEqual(onlyLogin.map((item) => item.value), ["refresh", "dashboard:anthropic", "close"]);

	const combined = usageMenu(resolveScope("google", ["anthropic", "openai-codex"]), "google", ["anthropic", "openai-codex"]);
	assert.deepEqual(combined.map((item) => item.value), ["refresh", "dashboard:anthropic", "dashboard:openai-codex", "close"]);

	const combinedWithCurrent = usageMenu({ kind: "all", providers: USAGE_PROVIDERS.filter((provider) => provider.id !== "openai") }, "openai-codex", ["anthropic", "openai-codex"]);
	assert.deepEqual(combinedWithCurrent.map((item) => item.value), [
		"refresh",
		"dashboard:anthropic",
		"dashboard:openai-codex",
		"only:openai-codex",
		"close",
	]);
});

test("ChatGPT scope and menu require OAuth availability, including dual logins and API-key fallback", () => {
	const dual = ["openai", "openai-codex"] as const;
	assert.deepEqual(resolveScope("openai", dual).providers.map((provider) => provider.id), ["openai"]);
	assert.deepEqual(usageMenu(resolveScope("openai", dual), "openai", dual).map((item) => item.value), ["refresh", "dashboard:openai", "all", "close"]);
	const fallback = resolveScope("openai", ["openai-codex"]);
	assert.deepEqual(fallback.providers.map((provider) => provider.id), ["openai-codex"]);
	assert.deepEqual(usageMenu(fallback, "openai", ["openai-codex"]).map((item) => item.value), ["refresh", "dashboard:openai-codex", "close"]);
	const all = resolveScope("google", dual);
	assert.deepEqual(all.providers.map((provider) => provider.id), ["openai-codex", "openai"]);
	assert.deepEqual(usageMenu(all, "google", dual).map((item) => item.value), ["refresh", "dashboard:openai-codex", "dashboard:openai", "close"]);
	assert.deepEqual(resolveScope("openai", []).providers, []);
});

test("recognizes only known usage failure codes", () => {
	assert.equal(errorCode({ code: "timeout" }), "timeout");
	assert.equal(errorCode({ code: "nonsense" }), undefined);
	assert.equal(errorCode(new Error("boom")), undefined);
});
