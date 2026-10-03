import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

test("bash approval preserves medium redirection, high deletion, callback choices and safe pass-through", async () => {
	const root = mkdtempSync(join(tmpdir(), "bash-guard-types-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/bash-guard/index.ts", import.meta.url))],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const handler = loaded.extensions[0].handlers.get("tool_call")?.[0];
		assert.ok(handler);
		const views: string[] = [];
		let key = "\r";
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: Pick<TUI, "requestRender">, theme: Pick<Theme, "fg" | "bold">, kb: object, done: (result: string) => void) => Component, options: { overlay: boolean }) {
					assert.equal(options.overlay, true);
					let result: string | undefined;
					const component = factory({ requestRender() {} }, { fg: (_color, value) => value, bold: (value) => value }, {}, (value) => { result = value; });
					views.push(component.render(100).join("\n"));
					component.handleInput?.(key);
					assert.ok(result);
					return result;
				},
			},
		};
		const emit = (command: string) => handler({ type: "tool_call", toolName: "bash", toolCallId: command, input: { command } }, ctx);
		assert.equal(await emit("echo safe"), undefined);
		assert.equal(views.length, 0);
		assert.equal(await emit("echo value > output.txt"), undefined);
		assert.match(views[0], /Command flagged as MEDIUM risk/);
		assert.match(views[0], /shell output redirection/);
		assert.equal(await emit("rm file.txt > output.txt"), undefined);
		assert.match(views[1], /Command flagged as HIGH risk/);
		assert.match(views[1], /rm \(file deletion\)/);
		key = "\x1b";
		assert.partialDeepStrictEqual(await emit("git status"), { block: true });
		assert.match(views[2], /Command flagged as MEDIUM risk/);
		assert.partialDeepStrictEqual(await emit("git status"), { block: true });
		assert.equal(views.length, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
