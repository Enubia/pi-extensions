const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function renderInline(text) {
	return text
		.split(/(`[^`\n]+`)/)
		.map((part, index) => {
			if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			return escapeHtml(part).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		})
		.join("");
}

export function renderMarkdown(source) {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	let paragraph = [];
	let list = null;

	const flushParagraph = () => {
		if (paragraph.length > 0) out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${list.tag}>`);
		list = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			flushParagraph();
			flushList();
			const code = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
			out.push(`<pre><code>${escapeHtml(code.map((l) => `${l}\n`).join(""))}</code></pre>`);
			continue;
		}
		if (line.trim() === "") {
			flushParagraph();
			flushList();
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
			continue;
		}
		const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
		if (item) {
			flushParagraph();
			const tag = item[1] ? "ul" : "ol";
			if (list && list.tag !== tag) flushList();
			list ??= { tag, items: [] };
			list.items.push(item[3]);
			continue;
		}
		flushList();
		paragraph.push(line);
	}
	flushParagraph();
	flushList();
	return out.join("");
}
