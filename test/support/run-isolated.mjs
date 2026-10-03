import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A test command is required");
const root = mkdtempSync(join(tmpdir(), "pi-extension-tests-"));
try {
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	mkdirSync(home);
	mkdirSync(agentDir);
	const env = {
		PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
		HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		...(process.env.PI_TEST_HOST_ROOT ? { PI_TEST_HOST_ROOT: process.env.PI_TEST_HOST_ROOT } : {}),
	};
	const result = spawnSync(command, args, { env, stdio: "inherit", timeout: 120_000 });
	if (result.error) console.error(result.error.message);
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}
