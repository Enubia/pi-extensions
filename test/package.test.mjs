import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoints = [
	"./extensions/ask-user-question.ts",
	"./extensions/bash-guard/index.ts",
	"./extensions/cmux-notify/index.ts",
	"./extensions/lsp/index.ts",
	"./extensions/observational-memory/src/index.ts",
	"./extensions/om-factor/index.ts",
	"./extensions/provider-failover/index.ts",
	"./extensions/session-namer/index.ts",
	"./extensions/statusline.ts",
	"./extensions/subagent-models/index.ts",
	"./extensions/usage/index.ts",
];
const manifest = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the private package exposes exactly eleven real extension factories", () => {
	const pkg = manifest();
	assert.equal(pkg.name, "@enubia/pi-extensions");
	assert.equal(pkg.version, "0.1.0");
	assert.equal(pkg.private, true);
	assert.equal(pkg.type, "module");
	assert.deepEqual(pkg.keywords, ["pi-package"]);
	assert.deepEqual(pkg.pi, { extensions: entrypoints });
	for (const entrypoint of pkg.pi.extensions) assert.ok(statSync(join(root, entrypoint)).isFile());
});

test("root owns patched shell-quote while all five host packages remain unbounded peers", () => {
	const pkg = manifest();
	assert.deepEqual(pkg.dependencies, { "shell-quote": "^1.12.0" });
	assert.deepEqual(pkg.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-agent-core": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	for (const name of Object.keys(pkg.peerDependencies)) assert.match(pkg.devDependencies[name], /^(?:\^|~)?\d+\.\d+\.\d+/);
	assert.equal(pkg.workspaces, undefined);
	assert.equal(pkg.license, undefined);
	for (const name of ["preinstall", "install", "postinstall"]) assert.equal(pkg.scripts?.[name], undefined);
});

test("the install graph keeps patched shell-quote and confines brace-expansion to Pi development dependencies", () => {
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	assert.deepEqual(lock.packages[""].dependencies, { "shell-quote": "^1.12.0" });
	assert.equal(lock.packages["node_modules/shell-quote"].version, "1.12.0");
	const runtime = Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev).map(([path]) => path);
	assert.deepEqual(runtime, ["node_modules/shell-quote"]);
	const bracePackages = Object.entries(lock.packages).filter(([path]) => path.endsWith("/brace-expansion"));
	assert.deepEqual(bracePackages.map(([path]) => path), ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"]);
	for (const [path, pkg] of bracePackages) {
		assert.equal(pkg.dev, true, path);
	}
	const hostPath = "node_modules/@earendil-works/pi-coding-agent";
	assert.equal(lock.packages[hostPath].dev, true);
	assert.ok(lock.packages[hostPath].dependencies.minimatch);
	assert.ok(lock.packages[`${hostPath}/node_modules/minimatch`].dependencies["brace-expansion"]);
	for (const name of Object.keys(manifest().peerDependencies)) {
		assert.equal(lock.packages[`node_modules/${name}`].version, name === "typebox" ? "1.3.27" : "1.0.0");
		assert.equal(lock.packages[`node_modules/${name}`].dev, true);
	}
});

test("the Node runner discovers centralized suites without mixing in Vitest", () => {
	const result = spawnSync(process.execPath, ["test/support/run-tests.mjs", "--list"], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const files = result.stdout.trim().split("\n");
	assert.ok(files.includes("test/package.test.mjs"));
	assert.ok(files.includes("test/statusline/statusline-memory.test.ts"));
	assert.ok(files.includes("test/support/host-modules.test.ts"));
	assert.ok(files.includes("test/lsp/manager.test.ts"));
	assert.ok(files.includes("test/lsp/typescript.integration.test.ts"));
	assert.equal(files.filter(file => file.endsWith(".test.ts")).length, 24);
	assert.equal(files.some(file => file.startsWith("test/observational-memory/")), false);
});

test("developer test commands isolate runtime state and discard inherited credentials", () => {
	const result = spawnSync(process.execPath, ["test/support/run-isolated.mjs", process.execPath, "--input-type=module", "-e", "console.log(JSON.stringify({home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,offline:process.env.PI_OFFLINE,key:process.env.OPENAI_API_KEY}))"], {
		cwd: root, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "synthetic-inherited-key" },
	});
	assert.equal(result.status, 0, result.stderr);
	const env = JSON.parse(result.stdout);
	assert.notEqual(env.home, process.env.HOME);
	assert.notEqual(env.agent, process.env.PI_CODING_AGENT_DIR);
	assert.equal(env.offline, "1");
	assert.equal(env.key, undefined);
	assert.equal(existsSync(env.home), false);
	assert.equal(existsSync(env.agent), false);
});

test("usage fixtures contain synthetic account profiles and deterministic reset schedules", () => {
	const anthropic = readFileSync(join(root, "test/usage/anthropic.test.ts"), "utf8");
	const openai = readFileSync(join(root, "test/usage/openai.test.ts"), "utf8");
	const runtime = readFileSync(join(root, "test/usage/runtime.test.ts"), "utf8");
	assert.match(anthropic, /Synthetic Example Workspace/);
	assert.match(anthropic, /member-alpha@example\.invalid/);
	assert.match(anthropic, /default_synthetic_plan_2x/);
	assert.match(anthropic, /2030-01-01T14:10:00Z/);
	assert.match(openai, /synthetic-account-primary/);
	assert.match(runtime, /synthetic-account-runtime/);
});

test("the source snapshot excludes personal state and retains both upstream MIT notices", () => {
	for (const path of [".pi", "extensions/pi-automode", "extensions/tests", "extensions/observational-memory/tests", "tests", "test-support", "auth.json", "settings.json", "subagent-models.json", "lsp.json", "observational-memory"]) {
		assert.equal(existsSync(join(root, path)), false, path);
	}
	const files = readdirSync(join(root, "test/support")).sort();
	for (const file of ["host-modules.mjs", "host-modules.test.ts", "register.mjs", "run-tests.mjs"]) assert.ok(files.includes(file));
	const license = readFileSync(join(root, "extensions/observational-memory/LICENSE"), "utf8");
	assert.match(license, /Copyright \(c\) 2026 Amos Blomqvist/);
	assert.match(license, /Copyright \(c\) 2026 pi-observational-memory contributors/);
	assert.match(license, /Permission is hereby granted/);
	assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
