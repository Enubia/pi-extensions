import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveHostModule, resolveHostRoot } from "./support/host-modules.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.PI_TEST_HOST_ROOT, "Set PI_TEST_HOST_ROOT to the read-only installed host for integration testing");
const hostRoot = resolveHostRoot();
const { DefaultResourceLoader, SettingsManager } = await import(resolveHostModule("@earendil-works/pi-coding-agent", hostRoot));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-package-install-")));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
try {
	const packageDir = join(sandbox, "package");
	const home = join(sandbox, "home");
	const agentDir = join(sandbox, "agent");
	const cwd = join(sandbox, "workspace");
	for (const dir of [packageDir, home, agentDir, cwd]) mkdirSync(dir);
	for (const path of ["package.json", "package-lock.json", "extensions"]) cpSync(join(root, path), join(packageDir, path), { recursive: true });
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const installed = spawnSync("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
		cwd: packageDir,
		env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, npm_config_cache: join(sandbox, "npm-cache") },
		encoding: "utf8", timeout: 60_000,
	});
	assert.equal(installed.status, 0, installed.stderr);
	const modules = readdirSync(join(packageDir, "node_modules")).filter(name => !name.startsWith("."));
	assert.deepEqual(modules, ["shell-quote"]);
	for (const name of ["@earendil-works", "typebox"]) assert.equal(existsSync(join(packageDir, "node_modules", name)), false);
	const require = createRequire(pathToFileURL(join(packageDir, "extensions/bash-guard/index.ts")));
	const quotePath = require.resolve("shell-quote");
	assert.equal(quotePath, join(packageDir, "node_modules/shell-quote/index.js"));
	const shellQuote = await import(pathToFileURL(quotePath).href);
	assert.deepEqual(shellQuote.default.parse("echo 'synthetic value'"), ["echo", "synthetic value"]);
	assert.equal(JSON.parse(readFileSync(join(packageDir, "node_modules/shell-quote/package.json"))).version, "1.8.3");
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
		additionalExtensionPaths: [packageDir],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 11);
	const order = result.extensions.map(extension => `./${relative(packageDir, extension.path)}`);
	const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions;
	assert.deepEqual(order, expected);
	const registrations = result.extensions.map(extension => ({
		path: `./${relative(packageDir, extension.path)}`,
		tools: [...extension.tools.keys()], commands: [...extension.commands.keys()], events: [...extension.handlers.keys()],
	}));
	for (const key of ["tools", "commands"]) {
		const names = registrations.flatMap(registration => registration[key]);
		assert.equal(new Set(names).size, names.length, `Duplicate ${key}`);
	}
	assert.equal(existsSync(join(agentDir, "extensions")), false);
	console.log(JSON.stringify({ hostVersion: JSON.parse(readFileSync(join(hostRoot, "package.json"))).version, productionModules: modules, order, registrations, duplicates: [], agentDirectoryHasLooseExtensions: false }, null, 2));
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(sandbox, { recursive: true, force: true });
}
