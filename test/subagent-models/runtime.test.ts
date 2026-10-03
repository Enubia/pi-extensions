import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { DefaultResourceLoader, SettingsManager, ModelRegistry, ModelRuntime, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

test("qualified configured models reach the installed registry's thinking lookup through the command", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-models-runtime-"));
	try {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const model = registry.getAll().find((candidate) => candidate.provider === "openai" && candidate.reasoning);
		assert.ok(model);
		mkdirSync(join(root, ".pi"));
		writeFileSync(join(root, ".pi", "subagent-models.json"), JSON.stringify({
			fallbackProfile: "target",
			profiles: { target: { providers: ["openai"], tiers: { standard: { model: `${model.provider}/${model.id}`, thinking: "high" } } } },
		}));
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/subagent-models/index.ts", import.meta.url))],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0].commands.get("subagent-models");
		assert.ok(command);
		const notifications: { message: string; level: string }[] = [];
		await command.handler("", {
			cwd: root, hasUI: false, model, modelRegistry: registry,
			ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		} as ExtensionCommandContext);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		assert.doesNotMatch(notifications[0].message, /not in the model registry|does not support/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	}
});
