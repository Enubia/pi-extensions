import { describe, expect, it } from "vitest";
import { describeModel, parseModelArgument, patchModelSettings } from "../../extensions/observational-memory/src/commands/model.js";

describe("parseModelArgument", () => {
	it("parses provider/id with optional thinking", () => {
		expect(parseModelArgument("openai-codex/gpt-5.6-luna")).toEqual({ ok: true, model: { provider: "openai-codex", id: "gpt-5.6-luna" } });
		expect(parseModelArgument("anthropic/claude-fable-5-1:high")).toEqual({ ok: true, model: { provider: "anthropic", id: "claude-fable-5-1", thinking: "high" } });
	});

	it("clears with clear/unset/none", () => {
		expect(parseModelArgument("clear")).toEqual({ ok: true, model: undefined });
	});

	it("rejects malformed refs and unknown thinking levels", () => {
		expect(parseModelArgument("gpt-5").ok).toBe(false);
		expect(parseModelArgument("openai/gpt-5:turbo").ok).toBe(false);
	});
});

describe("patchModelSettings", () => {
	it("writes the model into the observational-memory block and preserves other keys", () => {
		const out = JSON.parse(patchModelSettings('{"theme":"dark","observational-memory":{"observeAfterTokens":1}}', { provider: "p", id: "m", thinking: "low" }));
		expect(out).toEqual({ theme: "dark", "observational-memory": { observeAfterTokens: 1, model: { provider: "p", id: "m", thinking: "low" } } });
	});

	it("removes the model when unset", () => {
		const out = JSON.parse(patchModelSettings('{"observational-memory":{"model":{"provider":"p","id":"m"},"x":1}}', undefined));
		expect(out).toEqual({ "observational-memory": { x: 1 } });
	});
});

describe("describeModel", () => {
	it("renders refs and the unset case", () => {
		expect(describeModel(undefined)).toBe("session model");
		expect(describeModel({ provider: "p", id: "m", thinking: "medium" })).toBe("p/m:medium");
	});
});
