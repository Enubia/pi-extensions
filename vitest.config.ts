import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { resolveHostModule, resolveHostRoot } from "./test/support/host-modules.mjs";

const hostRoot = resolveHostRoot();
const names = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

export default defineConfig({
	resolve: {
		alias: names.map(name => {
			const url = resolveHostModule(name, hostRoot);
			if (!url) throw new Error(`Unable to resolve development host module ${name}`);
			return { find: new RegExp(`^${name.replaceAll("/", "\\/")}$`), replacement: fileURLToPath(url) };
		}),
	},
	test: {
		environment: "node",
		include: ["test/observational-memory/**/*.test.ts"],
	},
});
