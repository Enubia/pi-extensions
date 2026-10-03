import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspManager } from "../../extensions/lsp/manager.ts";
import { typescriptSpec } from "../../extensions/lsp/registry.ts";

for (const resolvedOptions of [true, false]) {
	test(`initialization sends ${resolvedOptions ? "resolved compiler" : "configured server"} options to the server`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-initialize-"));
		const options = { tsserver: { path: "/workspace/typescript/lib/tsserver.js" } };
		const server = `
import { MessageDecoder, encodeMessage } from ${JSON.stringify(new URL("../../extensions/lsp/protocol.ts", import.meta.url).href)};
const decoder = new MessageDecoder();
process.stdin.on("data", (chunk) => {
	for (const message of decoder.push(chunk)) {
		if (message.method === "initialize") {
			const valid = message.params?.initializationOptions?.tsserver?.path === "/workspace/typescript/lib/tsserver.js";
			process.stdout.write(encodeMessage({ jsonrpc: "2.0", id: message.id, ...(valid ? { result: { capabilities: {} } } : { error: { code: -32602, message: "Compiler was not pinned" } }) }));
		}
		if (message.method === "shutdown") process.stdout.write(encodeMessage({ jsonrpc: "2.0", id: message.id, result: null }));
		if (message.method === "exit") process.exit(0);
	}
});
`;
		const manager = new LspManager({ cwd: root, specs: [{
			...typescriptSpec,
			initializationOptions: resolvedOptions ? undefined : options,
			resolve: () => ({ command: process.execPath, args: ["--input-type=module", "-e", server], initializationOptions: resolvedOptions ? options : undefined }),
		}] });
		try {
			writeFileSync(join(root, "tsconfig.json"), "{}");
			const { client } = await manager.clientFor("index.ts");
			assert.equal(client.state, "ready");
		} finally {
			await manager.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("native startup failures report the selected launcher and missing platform dependency without falling back", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lsp-manager-"));
	const manager = new LspManager({ cwd: root, which: () => "/must-not-launch/legacy-bridge" });
	try {
		const pkg = join(root, "node_modules", "typescript");
		mkdirSync(join(pkg, "bin"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2", bin: { tsc: "bin/tsc" } }));
		const launcher = join(pkg, "bin", "tsc");
		writeFileSync(launcher, 'process.stderr.write("Unable to resolve @typescript/typescript-test-platform. Missing optional dependency.\\n"); process.exit(1);');
		writeFileSync(join(root, "tsconfig.json"), "{}");
		await assert.rejects(manager.clientFor("index.ts"), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(launcher), error.message);
			assert.match(error.message, /Unable to resolve @typescript\/typescript-test-platform/);
			return true;
		});
		assert.equal(manager.readyClients().length, 0);
		await assert.rejects(manager.clientFor("index.ts"), /Use \/lsp restart/);
	} finally {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
