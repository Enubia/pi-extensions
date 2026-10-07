import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("a relocated package footer reads bundled memory and refreshes the physical threshold without token growth", async () => {
	const root = mkdtempSync(join(tmpdir(), "statusline-memory-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let dispose: (() => void) | undefined;
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		const packageDir = join(root, "package");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		mkdirSync(packageDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			"observational-memory": { compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokensRatioByProvider: { other: 0.25 } },
		}));
		cpSync(join(import.meta.dirname, "../../extensions/statusline.ts"), join(packageDir, "statusline.ts"));
		cpSync(join(import.meta.dirname, "../../extensions/observational-memory"), join(packageDir, "observational-memory"), { recursive: true });
		assert.equal(existsSync(join(agentDir, "extensions")), false);
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [pathToFileURL(join(packageDir, "statusline.ts")).pathname],
			noSkills: true, noPromptTemplates: true, noThemes: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory() });
		dispose = () => session.dispose();
		const start = loaded.extensions[0].handlers.get("session_start")?.[0];
		assert.ok(start);
		let footer: { render: (width: number) => string[] } = { render() { throw new Error("Footer not installed"); } };
		let contextWindow = 128_000;
		const statuses = new Map<string, string>();
		let ready: () => void = () => {};
		const rendered = new Promise<void>(resolve => { ready = resolve; });
		const ctx = {
			cwd,
			model: { provider: "router", id: "auto", api: "pi-virtual", contextWindow: 1_000_000 },
			getContextUsage: () => ({ tokens: 32_000, percent: 25, contextWindow }),
			sessionManager: { getSessionId: () => "synthetic-memory-session", getBranch: () => [] },
			ui: { setFooter(factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) {
				footer = factory({ requestRender: () => ready() }, { fg: (_color: string, text: string) => text }, { getExtensionStatuses: () => statuses });
			} },
		};
		await start({ type: "session_start" }, ctx as never);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([rendered, new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Bundled memory footer did not become ready")), 5_000);
			})]);
		} finally { clearTimeout(timer); }
		assert.match(footer.render(240)[0], /cmp .*50%/);
		assert.doesNotMatch(footer.render(240)[0], /⏸/);
		statuses.set("observational-memory", "om ⏸ obs ref");
		assert.match(footer.render(240)[0], /obs⏸ \[.*ref⏸ \[.*cmp \[/);
		statuses.clear();
		assert.doesNotMatch(footer.render(240)[0], /⏸/);
		contextWindow = 256_000;
		assert.match(footer.render(240)[0], /cmp .*25%/);
		ctx.model.provider = "other";
		assert.match(footer.render(240)[0], /cmp .*50%/);
		assert.equal(existsSync(join(agentDir, "extensions")), false);
	} finally {
		dispose?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	}
});
