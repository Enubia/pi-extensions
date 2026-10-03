import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, mock, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "subagent-models-menu-"));
const existing = join(root, "node_modules", "@earendil-works", "pi-ai");
mkdirSync(existing, { recursive: true });
const sentinel = join(existing, "sentinel.txt");
writeFileSync(sentinel, "pre-existing dependency");
const fixture = join(root, "fixture");
mkdirSync(fixture);
copyFileSync(join(import.meta.dirname, "../../extensions/subagent-models/index.ts"), join(fixture, "index.ts"));
copyFileSync(join(import.meta.dirname, "../../extensions/subagent-models/core.ts"), join(fixture, "core.ts"));
const modules = join(fixture, "node_modules", "@earendil-works");
for (const name of ["pi-ai", "pi-coding-agent"]) {
	const dir = join(modules, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, type: "module", exports: "./index.js" }));
	writeFileSync(join(dir, "index.js"), "export const placeholder = true;\n");
}
after(() => { rmSync(root, { recursive: true, force: true }); });
mock.module(pathToFileURL(join(modules, "pi-ai", "index.js")).href, { namedExports: { getSupportedThinkingLevels: () => [] } });
mock.module(pathToFileURL(join(modules, "pi-coding-agent", "index.js")).href, { namedExports: { getAgentDir: () => root, isToolCallEventType: () => false } });
const { default: register } = await import(join(fixture, "index.ts"));

const profile = (tiers: Record<string, unknown>, defaultTier = "cheap") => ({ providers: ["vendor"], defaultTier, tiers });
const tiers = {
	frontier: { model: "vendor/front", thinking: "high" },
	cheap: { model: "vendor/economy" },
	standard: { model: "vendor/regular", thinking: "low" },
};
const BACK = "← back";

async function run(config: unknown, selections: (string | undefined)[]) {
	const cwd = mkdtempSync(join(root, "project-"));
	const dir = join(cwd, ".pi");
	mkdirSync(dir);
	const path = join(dir, "subagent-models.json");
	const original = JSON.stringify(config);
	writeFileSync(path, original);
	let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
	register({ on() {}, registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never);
	const prompts: { title: string; choices: string[] }[] = [];
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		cwd, hasUI: true, model: { provider: "vendor" }, modelRegistry: { find: () => undefined },
		ui: {
			select: async (title: string, choices: string[]) => {
				prompts.push({ title, choices });
				return selections.shift();
			},
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	await handler("", ctx);
	return { original, contents: readFileSync(path, "utf8"), prompts, notifications };
}

const two = { fallbackProfile: "alpha", roles: { scout: "cheap" }, profiles: { alpha: profile(tiers), beta: profile({ standard: { model: "vendor/beta" } }, "standard") } };

test("profile choice shows configured tiers in canonical order, current marker, and persists chosen default", async () => {
	const result = await run(two, ["Edit default tier…", "alpha", "standard  vendor/regular:low", "Show resolved profile"]);
	assert.deepEqual(result.prompts[1], { title: "Profile to edit", choices: ["alpha", "beta", BACK] });
	assert.deepEqual(result.prompts[2], {
		title: "alpha default tier — now: cheap",
		choices: ["cheap     vendor/economy (current)", "standard  vendor/regular:low", "frontier  vendor/front:high", BACK],
	});
	assert.equal(JSON.parse(result.contents).profiles.alpha.defaultTier, "standard");
	assert.deepEqual(JSON.parse(result.contents).profiles.beta, two.profiles.beta);
	assert.ok(result.notifications.some(({ message }) => message === "subagent-models: alpha default tier → standard"));
	assert.ok(result.notifications.some(({ message }) => message.includes("Default tier: standard")));
});

test("sole profile skips profile picker and Escape or Back never writes", async () => {
	const single = { fallbackProfile: "alpha", profiles: { alpha: profile(tiers) } };
	for (const cancel of [undefined, BACK]) {
		const result = await run(single, ["Edit default tier…", cancel, "Close"]);
		assert.match(result.prompts[1].title, /^alpha default tier/);
		assert.equal(result.contents, result.original);
		assert.deepEqual(result.notifications, []);
	}
	for (const cancel of [undefined, BACK]) {
		const result = await run(two, ["Edit default tier…", cancel, "Close"]);
		assert.equal(result.contents, result.original);
		assert.deepEqual(result.notifications, []);
	}
});

test("fixture cleanup preserves pre-existing dependency files", () => {
	rmSync(fixture, { recursive: true });
	assert.equal(readFileSync(sentinel, "utf8"), "pre-existing dependency");
});
