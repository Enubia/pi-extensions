import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../../apps/pi-remote/web/markdown.js";

test("escapes html outside and inside code", () => {
	assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
	assert.equal(renderMarkdown("`<b>`"), "<p><code>&lt;b&gt;</code></p>");
	assert.equal(renderMarkdown("```\n<i>&\n```"), "<pre><code>&lt;i&gt;&amp;\n</code></pre>");
});

test("renders fenced code with language ignored for markup", () => {
	assert.equal(renderMarkdown("```ts\nconst a = 1;\n```"), "<pre><code>const a = 1;\n</code></pre>");
});

test("unclosed fence still renders as code", () => {
	assert.equal(renderMarkdown("```\nabc"), "<pre><code>abc\n</code></pre>");
});

test("renders bold and inline code, not markdown inside code", () => {
	assert.equal(renderMarkdown("a **b** `**c**`"), "<p>a <strong>b</strong> <code>**c**</code></p>");
});

test("renders headings", () => {
	assert.equal(renderMarkdown("# One\n### Three"), "<h1>One</h1><h3>Three</h3>");
});

test("renders unordered and ordered lists", () => {
	assert.equal(renderMarkdown("- a\n- **b**\n\n1. x\n2. y"), "<ul><li>a</li><li><strong>b</strong></li></ul><ol><li>x</li><li>y</li></ol>");
});

test("paragraphs split on blank lines and keep line breaks", () => {
	assert.equal(renderMarkdown("a\nb\n\nc"), "<p>a<br>b</p><p>c</p>");
});

test("does not render links or images as markup", () => {
	assert.equal(renderMarkdown("[x](javascript:alert(1)) ![i](u)"), "<p>[x](javascript:alert(1)) ![i](u)</p>");
});

test("escapes quotes", () => {
	assert.equal(renderMarkdown(`"a" 'b'`), "<p>&quot;a&quot; &#39;b&#39;</p>");
});

test("empty input renders empty string", () => {
	assert.equal(renderMarkdown(""), "");
});
