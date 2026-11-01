import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

process.env.PI_SUBAGENT_DEPTH = "1";

test("subagent guard inspects executed scripts, script writes and interpreter one-liners", async () => {
	const root = mkdtempSync(join(tmpdir(), "bash-guard-scripts-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/bash-guard/index.ts", import.meta.url))],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const handlers = loaded.extensions[0].handlers;
		const toolCall = handlers.get("tool_call")?.[0];
		const beforeStart = handlers.get("before_agent_start")?.[0];
		assert.ok(toolCall);
		assert.ok(beforeStart);

		const promptGuidelines: string[] = [];
		await beforeStart({ type: "before_agent_start", systemPromptOptions: { promptGuidelines } }, {});
		await beforeStart({ type: "before_agent_start", systemPromptOptions: { promptGuidelines } }, {});
		assert.equal(promptGuidelines.length, 1);
		assert.match(promptGuidelines[0], /Never circumvent/);

		const ctx = { cwd: root, hasUI: false };
		const call = (toolName: string, input: Record<string, unknown>) =>
			toolCall({ type: "tool_call", toolName, toolCallId: toolName, input }, ctx);
		const bash = (command: string) => call("bash", { command });
		const reasonOf = async (result: Promise<unknown>) => ((await result) as { reason?: string } | undefined)?.reason ?? "";

		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "cleanup.sh"), "#!/bin/sh\nset -e\nrm -rf \"$HOME/cache\"\n");
		chmodSync(join(root, "cleanup.sh"), 0o755);
		writeFileSync(join(root, "sub", "inner.sh"), "sudo true\n");
		writeFileSync(join(root, "outer.sh"), "echo start\nbash sub/inner.sh\n");
		writeFileSync(join(root, "safe.sh"), "# rm -rf / is never run here\necho ok\n");

		assert.match(await reasonOf(bash("bash cleanup.sh")), /recursive delete.*in script cleanup\.sh.*Do not work around/);
		assert.partialDeepStrictEqual(await bash("./cleanup.sh"), { block: true });
		assert.partialDeepStrictEqual(await bash("FOO=1 sh -e cleanup.sh"), { block: true });
		assert.partialDeepStrictEqual(await bash("cd sub && zsh ../cleanup.sh"), { block: true });
		assert.match(await reasonOf(bash("echo hi\nsource outer.sh")), /sudo.*in script sub\/inner\.sh/);
		assert.equal(await bash("bash safe.sh"), undefined);
		assert.equal(await bash("bash missing.sh"), undefined);
		assert.equal(await bash("bash -c 'echo hi'"), undefined);

		assert.partialDeepStrictEqual(await bash("python3 -c \"import shutil; shutil.rmtree('x')\""), { block: true });
		assert.partialDeepStrictEqual(await bash("node -e \"require('fs').rmSync('x', { recursive: true })\""), { block: true });

		assert.match(await reasonOf(call("write", { path: "nuke.sh", content: "rm -r build\n" })), /in script nuke\.sh/);
		assert.partialDeepStrictEqual(await call("write", { path: "tool", content: "#!/usr/bin/env python3\nimport shutil\nshutil.rmtree('x')\n" }), { block: true });
		assert.equal(await call("write", { path: "notes.md", content: "rm -rf build\n" }), undefined);
		assert.equal(await call("write", { path: "x.test.ts", content: "rmSync(dir, { recursive: true, force: true });\n" }), undefined);
		assert.equal(await call("write", { path: "ok.sh", content: "#!/bin/sh\necho ok\n" }), undefined);
		assert.partialDeepStrictEqual(await call("edit", { path: "cleanup.sh", edits: [{ oldText: "set -e", newText: "sudo rm x" }] }), { block: true });
		writeFileSync(join(root, "runner"), "#!/bin/sh\necho ok\n");
		assert.partialDeepStrictEqual(await call("edit", { path: "runner", edits: [{ oldText: "echo ok", newText: "git push" }] }), { block: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
