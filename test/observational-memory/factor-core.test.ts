import { describe, expect, it } from "vitest";
import { describeThreshold, effectiveThreshold, formatRatio, parseFactor, patchSettings, presetOptions, ratioFromOption } from "../../extensions/observational-memory/src/commands/factor-core.js";

describe("factor input", () => {
	it.each([["0.25", 0.25], [" .15 ", 0.15], ["15%", 0.15], ["35", 0.35], ["0.00001", 0.00001], ["0.99999", 0.99999]])("parses %s without rounding out of range", (input, ratio) => {
		expect(parseFactor(String(input))).toEqual({ ok: true, ratio });
	});

	it.each(["0", "1", "100%", "-0.2", "abc", "", "Infinity", "NaN"])("rejects %s", input => {
		expect(parseFactor(input).ok).toBe(false);
	});
});

describe("provider settings patch", () => {
	it("changes only the selected provider", () => {
		const settings = {
			theme: "dark",
			"observational-memory": {
				compactAfterTokens: 81000, compactAfterTokensMode: "calibrated", compactAfterTokensRatio: 0.68,
				compactAfterTokensRatioByProvider: { anthropic: 0.15, openai: 0.3 }, passive: false,
			},
		};
		const result = JSON.parse(patchSettings(JSON.stringify(settings), "openai", 0.5));
		expect(result).toEqual({ ...settings, "observational-memory": { ...settings["observational-memory"], compactAfterTokensRatioByProvider: { anthropic: 0.15, openai: 0.5 } } });
	});

	it("resets one provider without discarding other settings", () => {
		const raw = '{"observational-memory":{"compactAfterTokensRatio":0.3,"compactAfterTokensRatioByProvider":{"openai":0.5,"anthropic":0.15}}}';
		const result = patchSettings(raw, "openai", undefined);
		expect(JSON.parse(result)["observational-memory"]).toEqual({ compactAfterTokensRatio: 0.3, compactAfterTokensRatioByProvider: { anthropic: 0.15 } });
		expect(JSON.parse(patchSettings(result, "anthropic", undefined))["observational-memory"]).toEqual({ compactAfterTokensRatio: 0.3 });
	});

	it.each(["", "{}", "\uFEFF{}"])("initializes missing settings (%s)", raw => {
		const result = patchSettings(raw, "openai", 0.5);
		expect(JSON.parse(result)).toEqual({ "observational-memory": { compactAfterTokensRatioByProvider: { openai: 0.5 } } });
		expect(result.endsWith("\n")).toBe(true);
	});

	it.each(["[]", "null", "broken", '{"observational-memory":[]}', '{"observational-memory":{"compactAfterTokensRatioByProvider":[]}}'])("refuses to overwrite malformed settings (%s)", raw => {
		expect(() => patchSettings(raw, "openai", 0.5)).toThrow();
	});

	it("preserves exact arbitrary provider keys", () => {
		const result = JSON.parse(patchSettings("{}", "__proto__", 0.2));
		expect(Object.hasOwn(result["observational-memory"].compactAfterTokensRatioByProvider, "__proto__")).toBe(true);
		expect(result["observational-memory"].compactAfterTokensRatioByProvider.__proto__).toBe(0.2);
	});

	it.each([0, 1, NaN, Infinity])("rejects invalid programmatic ratios (%s)", ratio => {
		expect(() => patchSettings("{}", "openai", ratio)).toThrow();
	});
});

describe("factor display", () => {
	it("calculates and formats threshold previews", () => {
		expect(effectiveThreshold(0.15, 200_000)).toBe(30_000);
		expect(effectiveThreshold(0.15, 0)).toBeUndefined();
		expect(effectiveThreshold(0.15, undefined)).toBeUndefined();
		expect(formatRatio(0.15)).toBe("15%");
		expect(formatRatio(0.685)).toBe("68.5%");
		expect(describeThreshold(0.15, 200_000)).toMatch(/compact at ~30,000 of 200,000 tokens/);
		expect(describeThreshold(0.15, undefined)).toMatch(/context window unknown/);
	});

	it("marks and round-trips preset and custom current values", () => {
		const options = presetOptions(200_000, 0.42);
		expect(options.some(option => option.startsWith("0.42") && option.includes("(current)"))).toBe(true);
		expect(ratioFromOption(options[0])).toBe(0.1);
	});
});
