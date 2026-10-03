import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportDir = dirname(fileURLToPath(import.meta.url));
const agentDir = dirname(dirname(supportDir));
const DEFAULT_PATTERNS = ["test/*.test.mjs", "test/*/*.test.ts"];

const args = process.argv.slice(2);
const discovered = globSync(DEFAULT_PATTERNS, { cwd: agentDir }).filter(file => !file.startsWith("test/observational-memory/")).sort();
if (args[0] === "--list") {
	console.log(discovered.join("\n"));
	process.exit(0);
}
const files = args.length > 0 ? args : discovered.map((file) => join(agentDir, file));

if (files.length === 0) {
	console.error("No test files matched.");
	process.exit(1);
}

const register = pathToFileURL(join(supportDir, "register.mjs")).href;
const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", register, "--test", ...files], { stdio: "inherit" });

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
