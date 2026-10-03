import assert from "node:assert/strict";
import test from "node:test";
import { describeThreshold, effectiveThreshold, formatRatio, parseFactor, patchSettings, presetOptions, ratioFromOption, readRatio } from "../../extensions/om-factor/core.ts";

test("parses decimals, bare percents, and percent suffixes", () => {
	assert.deepEqual(parseFactor("0.25"), { ok: true, ratio: 0.25 });
	assert.deepEqual(parseFactor(" .15 "), { ok: true, ratio: 0.15 });
	assert.deepEqual(parseFactor("15%"), { ok: true, ratio: 0.15 });
	assert.deepEqual(parseFactor("35"), { ok: true, ratio: 0.35 });
});

test("rejects values outside the range observational-memory accepts", () => {
	assert.equal(parseFactor("0").ok, false);
	assert.equal(parseFactor("1").ok, false);
	assert.equal(parseFactor("100%").ok, false);
	assert.equal(parseFactor("-0.2").ok, false);
	assert.equal(parseFactor("abc").ok, false);
	assert.equal(parseFactor("").ok, false);
});

test("patches only the observational-memory keys and keeps other settings", () => {
	const raw = JSON.stringify({ theme: "dark", "observational-memory": { compactAfterTokens: 81000, passive: false } }, null, 2);
	const patched = JSON.parse(patchSettings(raw, 0.3));
	assert.equal(patched.theme, "dark");
	assert.deepEqual(patched["observational-memory"], {
		compactAfterTokens: 81000,
		passive: false,
		compactAfterTokensMode: "ratio",
		compactAfterTokensRatio: 0.3,
	});
});

test("patches an empty or missing settings file into a valid object", () => {
	assert.deepEqual(JSON.parse(patchSettings("", 0.5)), {
		"observational-memory": { compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5 },
	});
});

test("patched output ends with a trailing newline", () => {
	assert.ok(patchSettings("{}", 0.2).endsWith("}\n"));
});

test("rejects non-object settings files", () => {
	assert.throws(() => patchSettings("[]", 0.2));
});

test("reads the current mode and ratio", () => {
	assert.deepEqual(readRatio({ "observational-memory": { compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.15 } }), {
		mode: "ratio",
		ratio: 0.15,
		compactAfterTokens: undefined,
	});
	assert.deepEqual(readRatio({}), { mode: undefined, ratio: undefined, compactAfterTokens: undefined });
});

test("mirrors resolveCompactAfterTokens for the effective threshold", () => {
	assert.equal(effectiveThreshold(0.15, 200_000), 30_000);
	assert.equal(effectiveThreshold(0.15, 0), undefined);
	assert.equal(effectiveThreshold(0.15, undefined), undefined);
});

test("formats ratios and thresholds for display", () => {
	assert.equal(formatRatio(0.15), "15%");
	assert.equal(formatRatio(0.685), "68.5%");
	assert.match(describeThreshold(0.15, 200_000), /compact at ~30,000 of 200,000 tokens/);
	assert.match(describeThreshold(0.15, undefined), /context window unknown/);
});

test("preset options mark the current value and round-trip back to a ratio", () => {
	const options = presetOptions(200_000, 0.15);
	assert.ok(options.some((option) => option.includes("0.15") && option.includes("(current)")));
	assert.equal(ratioFromOption(options[0]), 0.1);
});

test("preset options include a non-preset current value", () => {
	const options = presetOptions(200_000, 0.42);
	assert.ok(options.some((option) => option.startsWith("0.42")));
});
