import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import omFactor from "../../extensions/om-factor/index.js";
import observationalMemory from "../../extensions/observational-memory/src/index.js";

describe("factor ownership", () => {
	it("root manifest loads only OM for factor", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		expect(manifest.pi.extensions).toHaveLength(10);
		expect(manifest.pi.extensions).not.toContain("./extensions/om-factor/index.ts");
	});

	it.each([false, true])("shim and OM register exactly one factor in either order (%s)", (shimFirst) => {
		const commands: string[] = [];
		const events: Array<{ name: string; handler: Function }> = [];
		const pi = {
			registerCommand: (name: string) => commands.push(name),
			registerTool: vi.fn(),
			on: (name: string, handler: Function) => events.push({ name, handler }),
		} as unknown as ExtensionAPI;
		if (shimFirst) omFactor(pi);
		observationalMemory(pi);
		if (!shimFirst) omFactor(pi);
		expect(commands.filter(name => name === "om:factor")).toHaveLength(1);
		expect(events.filter(event => event.name === "session_start")).toHaveLength(2);
	});

	it("standalone shim only warns at session start", () => {
		const notify = vi.fn();
		const registerCommand = vi.fn();
		let handler: Function | undefined;
		omFactor({ registerCommand, on: (name: string, fn: Function) => {
			expect(name).toBe("session_start");
			handler = fn;
		} } as unknown as ExtensionAPI);
		expect(registerCommand).not.toHaveBeenCalled();
		handler?.({}, { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("enable observational-memory"), "warning");
	});
});
