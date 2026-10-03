import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtinSpecs, extensionOf, findRoot, languageIdFor, mergeSpecs, specForFile, typescriptSpec } from "../../extensions/lsp/registry.ts";

function fixture(): string {
	return mkdtempSync(join(tmpdir(), "pi-lsp-"));
}

test("specForFile maps by extension, case-insensitive", () => {
	assert.equal(specForFile(builtinSpecs, "a/b.ts")?.id, "typescript");
	assert.equal(specForFile(builtinSpecs, "a/b.TSX")?.id, "typescript");
	assert.equal(specForFile(builtinSpecs, "main.go")?.id, "go");
	assert.equal(specForFile(builtinSpecs, "lib.rs")?.id, "rust");
	assert.equal(specForFile(builtinSpecs, "x.py")?.id, "python");
	assert.equal(specForFile(builtinSpecs, "README.md"), undefined);
	assert.equal(extensionOf("noext"), "");
	assert.equal(languageIdFor(typescriptSpec, "a.tsx"), "typescriptreact");
});

test("findRoot walks up to the nearest marker but not past cwd", () => {
	const dir = fixture();
	try {
		mkdirSync(join(dir, "pkg", "src"), { recursive: true });
		writeFileSync(join(dir, "pkg", "tsconfig.json"), "{}");
		writeFileSync(join(dir, "package.json"), "{}");
		assert.equal(findRoot(join(dir, "pkg", "src", "a.ts"), ["tsconfig.json"], dir), join(dir, "pkg"));
		assert.equal(findRoot(join(dir, "pkg", "src", "a.ts"), ["package.json"], dir), dir);
		assert.equal(findRoot(join(dir, "pkg", "src", "a.ts"), ["Cargo.toml"], dir), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("typescript resolve prefers tsc --lsp when tsserver.js is missing, else typescript-language-server", () => {
	const dir = fixture();
	try {
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(dir, "node_modules", ".bin", "tsc"), "");
		const which = (bin: string) => (bin === "typescript-language-server" ? "/usr/bin/tsls" : undefined);
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which }), { command: join(dir, "node_modules", ".bin", "tsc"), args: ["--lsp", "--stdio"] });
		mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "");
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which }), { command: "/usr/bin/tsls", args: ["--stdio"] });
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which: () => undefined }), { command: join(dir, "node_modules", ".bin", "tsc"), args: ["--lsp", "--stdio"] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mergeSpecs lets user config override, add, and disable servers", () => {
	const merged = mergeSpecs(builtinSpecs, {
		disabled: ["python"],
		servers: [
			{ id: "vue", extensions: { ".vue": "vue" }, rootMarkers: ["package.json"], bin: "vue-language-server", args: ["--stdio"] },
			{ id: "go", enabled: false, extensions: {}, bin: "x" },
			{ id: "rust", extensions: { ".rs": "rust" }, bin: "{root}/bin/ra" },
		],
	});
	const ids = merged.map((s) => s.id).sort();
	assert.deepEqual(ids, ["rust", "typescript", "vue"]);
	const rust = merged.find((s) => s.id === "rust")!;
	assert.deepEqual(rust.resolve({ root: "/proj", which: () => undefined }), { command: "/proj/bin/ra", args: [] });
	const vue = merged.find((s) => s.id === "vue")!;
	assert.equal(vue.resolve({ root: "/proj", which: () => undefined }), undefined);
	assert.deepEqual(vue.resolve({ root: "/proj", which: (b) => `/bin/${b}` }), { command: "/bin/vue-language-server", args: ["--stdio"] });
});
