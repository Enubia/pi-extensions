import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LspManager, whichOnPath } from "../../extensions/lsp/manager.ts";

for (const [name, env] of [["typescript", "PI_LSP_TEST_TS7_PACKAGE"], ["@typescript/native-preview", "PI_LSP_TEST_PREVIEW_PACKAGE"], ["typescript", "PI_LSP_TEST_LEGACY_PACKAGE"]]) {
	const installed = process.env[env];
	const legacy = env === "PI_LSP_TEST_LEGACY_PACKAGE";
	test(`${env}: all six tools work through ancestor discovery, including diagnostics after edits`, {
		skip: installed ? false : `Set ${env} to an installed package directory to run`,
		timeout: 30_000,
	}, async () => {
		assert.ok(installed);
		const packageDir = resolve(installed);
		const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		assert.equal(metadata.name, name);
		assert.match(metadata.version, legacy ? /^[56]\./ : /^7\./);
		const workspace = mkdtempSync(join(tmpdir(), "pi-lsp-typescript-"));
		const manager = new LspManager({ cwd: workspace, which: legacy ? whichOnPath : () => "/must-not-launch/legacy-bridge" });
		try {
			const link = join(workspace, "node_modules", name);
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(packageDir, link, "junction");
			const root = join(workspace, "packages", "core");
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
			const file = join(root, "index.ts");
			const good = "export const answer: number = 42;\nexport const result = answer;\n";
			writeFileSync(file, good);
			const { client } = await manager.clientFor(file);
			assert.equal(client.root, root);
			assert.equal(client.supportsPullDiagnostics, !legacy);
			if (legacy) assert.deepEqual(client.command.initializationOptions, { tsserver: { path: join(link, "lib", "tsserver.js") } });
			const position = { line: 1, character: 22 };
			const references = await client.references(file, position, true);
			assert.equal(references.length, 2);
			assert.ok(references.every((reference) => reference.uri === pathToFileURL(file).href));
			if (!legacy) assert.equal((await client.references(file, position, false)).length, 1);
			assert.ok(await client.hover(file, position));
			const definitions = await client.definition(file, position);
			assert.equal(definitions.length, 1);
			assert.equal(definitions[0].range.start.line, 0);
			assert.equal((await client.documentSymbols(file)).length, 2);
			assert.ok((await client.workspaceSymbols("answer")).some((symbol) => symbol.name === "answer"));
			assert.equal((await client.diagnostics(file)).length, 0);
			writeFileSync(file, good.replace("= 42", '= "wrong"'));
			assert.ok((await client.diagnostics(file)).some((diagnostic) => diagnostic.code === 2322));
			writeFileSync(file, good);
			assert.equal((await client.diagnostics(file)).length, 0);
			assert.equal(await manager.restart("typescript"), 1);
			assert.equal(client.state, "stopped");
			const restarted = await manager.clientFor(file);
			assert.equal((await restarted.client.references(file, position, true)).length, 2);
		} finally {
			await manager.dispose();
			rmSync(workspace, { recursive: true, force: true });
		}
	});
}
