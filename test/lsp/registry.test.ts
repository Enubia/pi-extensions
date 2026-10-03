import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function installPackage(root: string, name: string, version: string, bin: Record<string, string>): string {
	const dir = join(root, "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, bin }));
	for (const entry of Object.values(bin)) {
		mkdirSync(join(dir, entry, ".."), { recursive: true });
		writeFileSync(join(dir, entry), "");
	}
	return dir;
}

test("typescript resolves ancestor-installed TS7 before a PATH bridge without changing the project root", () => {
	const dir = fixture();
	try {
		const workspace = join(dir, ".worktrees", "feature");
		const root = join(workspace, "packages", "core");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), "{}");
		const pkg = installPackage(workspace, "typescript", "7.0.2", { tsc: "./bin/tsc" });
		installPackage(root, "@typescript/native-preview", "7.1.0-dev.20261003.1", { tsgo: "bin/tsgo" });
		mkdirSync(join(root, "node_modules", ".bin"));
		writeFileSync(join(root, "node_modules", ".bin", "tsc"), "unrelated executable");
		assert.equal(findRoot(join(root, "src", "index.ts"), typescriptSpec.rootMarkers, dir), root);
		assert.deepEqual(typescriptSpec.resolve({ root, which: () => "/global/typescript-language-server" }), {
			command: process.execPath,
			args: [join(pkg, "bin", "tsc"), "--lsp", "--stdio"],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const version of ["5.9.3", "6.0.0"]) {
	test(`typescript ${version} uses an ancestor bridge pinned to the nearest legacy compiler`, () => {
		const dir = fixture();
		try {
			const root = join(dir, "packages", "core");
			installPackage(dir, "typescript", "7.0.2", { tsc: "bin/tsc" });
			installPackage(root, "@typescript/native-preview", "7.0.0-dev.20260707.2", { tsgo: "bin/tsgo" });
			const pkg = installPackage(root, "typescript", version, { tsc: "bin/tsc" });
			mkdirSync(join(pkg, "lib"));
			writeFileSync(join(pkg, "lib", "tsserver.js"), "");
			mkdirSync(join(dir, "node_modules", ".bin"));
			const bridge = join(dir, "node_modules", ".bin", "typescript-language-server");
			writeFileSync(bridge, "");
			assert.deepEqual(typescriptSpec.resolve({ root, which: () => "/global/bridge" }), {
				command: bridge,
				args: ["--stdio"],
				initializationOptions: { tsserver: { path: join(pkg, "lib", "tsserver.js") } },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("typescript resolves an ancestor native preview before a PATH bridge when no typescript package exists", () => {
	const dir = fixture();
	try {
		const root = join(dir, "packages", "core");
		mkdirSync(root, { recursive: true });
		const pkg = installPackage(dir, "@typescript/native-preview", "7.0.0-dev.20260707.2", { tsgo: "bin/tsgo.js" });
		assert.deepEqual(typescriptSpec.resolve({ root, which: () => "/global/bridge" }), {
			command: process.execPath,
			args: [join(pkg, "bin", "tsgo.js"), "--lsp", "--stdio"],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy TypeScript requires its own tsserver and bridge rather than falling back to a native preview", () => {
	const dir = fixture();
	try {
		const pkg = installPackage(dir, "typescript", "6.0.0", { tsc: "bin/tsc" });
		installPackage(dir, "@typescript/native-preview", "7.0.0-dev.20260707.2", { tsgo: "bin/tsgo" });
		assert.throws(() => typescriptSpec.resolve({ root: dir, which: () => "/global/bridge" }), /TypeScript 6\.0\.0.*has no tsserver\.js/);
		mkdirSync(join(pkg, "lib"));
		writeFileSync(join(pkg, "lib", "tsserver.js"), "");
		assert.throws(() => typescriptSpec.resolve({ root: dir, which: () => undefined }), /requires typescript-language-server/);
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which: (bin) => bin === "typescript-language-server" ? "/global/bridge" : undefined }), {
			command: "/global/bridge",
			args: ["--stdio"],
			initializationOptions: { tsserver: { path: join(pkg, "lib", "tsserver.js") } },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const broken of ["launcher", "metadata", "symlink"]) {
	test(`broken native ${broken} reports a repairable error rather than using an ancestor compiler or PATH bridge`, () => {
		const dir = fixture();
		try {
			installPackage(dir, "typescript", "7.0.2", { tsc: "bin/tsc" });
			const root = join(dir, "packages", "core");
			const pkg = installPackage(root, "typescript", "7.0.2", { tsc: "bin/tsc" });
			if (broken === "launcher") rmSync(join(pkg, "bin", "tsc"));
			if (broken === "metadata") writeFileSync(join(pkg, "package.json"), "{broken");
			if (broken === "symlink") {
				rmSync(pkg, { recursive: true });
				symlinkSync(join(root, "missing-package"), pkg, "junction");
			}
			assert.throws(() => typescriptSpec.resolve({ root, which: () => "/global/bridge" }), /Reinstall/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("typescript ignores unrelated tsc binaries and retains global-only bridge and tsgo fallbacks", () => {
	const dir = fixture();
	try {
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(dir, "node_modules", ".bin", "tsc"), "");
		assert.equal(typescriptSpec.resolve({ root: dir, which: () => undefined }), undefined);
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which: (bin) => bin === "tsgo" ? "/global/tsgo" : undefined }), {
			command: "/global/tsgo", args: ["--lsp", "--stdio"],
		});
		assert.deepEqual(typescriptSpec.resolve({ root: dir, which: (bin) => `/global/${bin}` }), {
			command: "/global/typescript-language-server", args: ["--stdio"],
		});
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
