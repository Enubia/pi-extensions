import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { resolveHostModule, resolveHostRoot } from "./host-modules.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-host-modules-"));
after(() => {
	rmSync(root, { recursive: true, force: true });
});

function writePackage(dir: string, pkg: Record<string, unknown>): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
	return dir;
}

function createHost(name: string): string {
	const hostRoot = writePackage(join(root, name, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), {
		name: "@earendil-works/pi-coding-agent",
		version: "0.99.1",
		exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
	});
	const nested = join(hostRoot, "node_modules", "@earendil-works");
	writePackage(join(nested, "pi-ai"), {
		name: "@earendil-works/pi-ai",
		main: "./dist/index.js",
		exports: {
			".": { import: "./dist/index.js" },
			"./compat": { import: "./dist/compat.js" },
			"./oauth": { import: "./dist/oauth.js" },
		},
	});
	writePackage(join(nested, "pi-tui"), { name: "@earendil-works/pi-tui", main: "dist/index.js" });
	writePackage(join(nested, "pi-agent-core"), {
		name: "@earendil-works/pi-agent-core",
		exports: { ".": { import: "./dist/index.js" } },
	});
	writePackage(join(hostRoot, "node_modules", "typebox"), {
		name: "typebox",
		exports: { ".": { import: "./build/index.mjs" }, "./value": { import: "./build/value/index.mjs" } },
	});
	return hostRoot;
}

const fakeHost = createHost("fake-install");
const fakeExecPath = join(root, "fake-install", "bin", "node");

test("resolveHostRoot prefers an explicit PI_TEST_HOST_ROOT override", () => {
	const resolved = resolveHostRoot({ env: { PI_TEST_HOST_ROOT: fakeHost }, execPath: "/nowhere/bin/node", cwd: root });
	assert.equal(resolved, fakeHost);
});

test("resolveHostRoot rejects an override that is not the Pi host package", () => {
	const bogus = writePackage(join(root, "bogus"), { name: "something-else" });
	assert.throws(() => resolveHostRoot({ env: { PI_TEST_HOST_ROOT: bogus }, execPath: fakeExecPath, cwd: root }), /PI_TEST_HOST_ROOT/);
});

test("resolveHostRoot falls back to the Node installation hosting the running interpreter", () => {
	const resolved = resolveHostRoot({ env: {}, execPath: fakeExecPath, cwd: root });
	assert.equal(resolved, fakeHost);
});

test("resolveHostRoot prefers a workspace node_modules install over the global one", () => {
	const workspace = join(root, "workspace", "nested");
	mkdirSync(workspace, { recursive: true });
	const local = writePackage(join(root, "workspace", "node_modules", "@earendil-works", "pi-coding-agent"), {
		name: "@earendil-works/pi-coding-agent",
		exports: { ".": { import: "./dist/index.js" } },
	});
	const resolved = resolveHostRoot({ env: {}, execPath: fakeExecPath, cwd: workspace });
	assert.equal(resolved, local);
});

test("resolveHostRoot reports an actionable error when no installed host exists", () => {
	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	assert.throws(() => resolveHostRoot({ env: {}, execPath: join(empty, "bin", "node"), cwd: empty }), /pi-coding-agent/);
});

test("resolveHostModule maps the host package to its ESM entry point", () => {
	const url = resolveHostModule("@earendil-works/pi-coding-agent", fakeHost);
	assert.equal(url, pathToFileURL(join(fakeHost, "dist", "index.js")).href);
});

test("resolveHostModule maps the pi-ai root to the compat entry the extension runtime uses", () => {
	const url = resolveHostModule("@earendil-works/pi-ai", fakeHost);
	assert.equal(url, pathToFileURL(join(fakeHost, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")).href);
});

test("resolveHostModule resolves declared subpaths", () => {
	const url = resolveHostModule("@earendil-works/pi-ai/oauth", fakeHost);
	assert.equal(url, pathToFileURL(join(fakeHost, "node_modules", "@earendil-works", "pi-ai", "dist", "oauth.js")).href);
});

test("resolveHostModule falls back to main for packages without exports", () => {
	const url = resolveHostModule("@earendil-works/pi-tui", fakeHost);
	assert.equal(url, pathToFileURL(join(fakeHost, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
});

test("standalone development resolves sibling packages without a global interpreter install", () => {
	const local = writePackage(join(root, "standalone", "node_modules", "@earendil-works", "pi-coding-agent"), {
		name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./dist/index.js" } },
	});
	writePackage(join(root, "standalone", "node_modules", "@earendil-works", "pi-ai"), {
		name: "@earendil-works/pi-ai", exports: { "./compat": { import: "./dist/compat.js" } },
	});
	assert.equal(resolveHostRoot({ env: {}, execPath: "/nowhere/bin/node", cwd: join(root, "standalone") }), local);
	assert.equal(resolveHostModule("@earendil-works/pi-ai", local), pathToFileURL(join(root, "standalone", "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")).href);
});

test("resolveHostModule maps canonical typebox and its declared subpaths", () => {
	const typebox = pathToFileURL(join(fakeHost, "node_modules", "typebox", "build", "index.mjs")).href;
	assert.equal(resolveHostModule("typebox", fakeHost), typebox);
	assert.equal(resolveHostModule("typebox/value", fakeHost), pathToFileURL(join(fakeHost, "node_modules", "typebox", "build", "value", "index.mjs")).href);
});

test("resolveHostModule ignores specifiers that are not host packages", () => {
	assert.equal(resolveHostModule("node-pty", fakeHost), undefined);
	assert.equal(resolveHostModule("./widget.ts", fakeHost), undefined);
	assert.equal(resolveHostModule("@earendil-works/pi-unknown", fakeHost), undefined);
});
