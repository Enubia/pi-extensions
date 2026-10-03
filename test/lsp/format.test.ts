import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLocations } from "../../extensions/lsp/client.ts";
import { displayPath, errorsOnly, formatDiagnostics, formatDocumentSymbols, formatHover, formatLocations, toLspPosition } from "../../extensions/lsp/format.ts";

test("positions convert between 1-based tool input and 0-based LSP", () => {
	assert.deepEqual(toLspPosition(1, 1), { line: 0, character: 0 });
	assert.deepEqual(toLspPosition(0, 0), { line: 0, character: 0 });
	assert.deepEqual(toLspPosition(4, 7), { line: 3, character: 6 });
});

test("diagnostics are formatted path:line:col severity: message (code) [source], errors first", () => {
	const out = formatDiagnostics(
		[
			{ range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } }, severity: 2, message: "unused", source: "ts", code: 6133 },
			{ range: { start: { line: 3, character: 6 }, end: { line: 3, character: 7 } }, severity: 1, message: "Type 'string' is not\n  assignable to type 'number'.", source: "ts", code: 2322 },
		],
		"src/index.ts",
	);
	assert.equal(out, "src/index.ts:4:7 error: Type 'string' is not assignable to type 'number'. (2322) [ts]\nsrc/index.ts:10:1 warning: unused (6133) [ts]");
	assert.equal(formatDiagnostics([], "a.ts"), "No diagnostics for a.ts.");
	assert.equal(errorsOnly([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 2, message: "w" }]).length, 0);
});

test("hover handles every MarkedString/MarkupContent shape", () => {
	assert.equal(formatHover(null), "No hover information at this position.");
	assert.equal(formatHover({ contents: { kind: "markdown", value: "```ts\nconst n: number\n```\n" } }), "```ts\nconst n: number\n```");
	assert.equal(formatHover({ contents: "plain" }), "plain");
	assert.equal(formatHover({ contents: [{ language: "go", value: "func F()" }, "doc"] }), "```go\nfunc F()\n```\n\ndoc");
});

test("locations are relative to cwd, capped, and LocationLinks normalised", () => {
	const cwd = "/proj";
	const locs = normalizeLocations([
		{ targetUri: "file:///proj/src/a.ts", targetRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }, targetSelectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } } },
	]);
	assert.equal(formatLocations(locs, cwd, 10), "src/a.ts:2:3");
	assert.equal(displayPath("file:///other/x.ts", cwd), "/other/x.ts");
	const many = Array.from({ length: 5 }, (_, i) => ({ uri: "file:///proj/f.ts", range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } } }));
	assert.match(formatLocations(many, cwd, 2), /\.\.\. 3 more \(5 total\)$/);
	assert.equal(formatLocations([], cwd, 2), "No locations found.");
});

test("document symbols render hierarchically", () => {
	const r = { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } };
	const out = formatDocumentSymbols([{ name: "Foo", kind: 5, range: r, selectionRange: r, children: [{ name: "bar", kind: 6, detail: "(): void", range: r, selectionRange: r }] }], 50);
	assert.equal(out, "class Foo :3\n  method bar (): void :3");
});
