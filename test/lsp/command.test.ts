import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lsp from "../../extensions/lsp/index.ts";
import { LspManager } from "../../extensions/lsp/manager.ts";
import { builtinSpecs, mergeSpecs } from "../../extensions/lsp/registry.ts";

function commandHarness() {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const notifications: string[] = [];
	const api: Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand"> = {
		on() { return () => {}; },
		registerTool() {},
		registerCommand(name, definition) {
			assert.equal(name, "lsp");
			command = definition;
		},
	};
	lsp(api as ExtensionAPI);
	assert.ok(command);
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	return { command, ctx, notifications };
}

test("lsp completes list and keeps existing subcommands", async () => {
	const { command } = commandHarness();
	assert.match(command.description ?? "", /list/);
	assert.deepEqual(await command.getArgumentCompletions?.("li"), [{ value: "list", label: "list" }]);
	assert.deepEqual((await command.getArgumentCompletions?.(""))?.map((item) => item.value), ["status", "restart", "list", "servers"]);
	assert.equal(await command.getArgumentCompletions?.("unknown"), null);
});

for (const subcommand of ["list", "servers"]) {
	test(`lsp ${subcommand} lists built-ins without resolving or starting servers`, async (t) => {
		const manager = new LspManager({
			cwd: process.cwd(),
			specs: builtinSpecs.map((spec) => ({ ...spec, resolve: () => { throw new Error("Must not resolve binaries"); } })),
		});
		t.mock.method(LspManager, "fromConfig", () => manager);
		const { command, ctx, notifications } = commandHarness();
		await command.handler(subcommand, ctx);
		assert.deepEqual(notifications, [
			"typescript: .ts .mts .cts .tsx .js .mjs .cjs .jsx\ngo: .go\nrust: .rs\npython: .py .pyi",
		]);
		assert.equal(manager.allClients().length, 0);
	});

	test(`lsp ${subcommand} reflects custom and disabled configuration`, async (t) => {
		const specs = mergeSpecs(builtinSpecs, {
			disabled: ["python"],
			servers: [{ id: "lua", extensions: { ".lua": "lua" }, bin: "lua-language-server" }],
		});
		t.mock.method(LspManager, "fromConfig", () => new LspManager({ cwd: process.cwd(), specs }));
		const { command, ctx, notifications } = commandHarness();
		await command.handler(subcommand, ctx);
		assert.match(notifications[0], /lua: \.lua/);
		assert.doesNotMatch(notifications[0], /python/);
	});

	test(`lsp ${subcommand} handles an empty configuration`, async (t) => {
		t.mock.method(LspManager, "fromConfig", () => new LspManager({ cwd: process.cwd(), specs: [] }));
		const { command, ctx, notifications } = commandHarness();
		await command.handler(subcommand, ctx);
		assert.deepEqual(notifications, ["No servers configured."]);
	});
}
