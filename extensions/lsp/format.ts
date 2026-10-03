import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic, DocumentSymbol, Hover, Location, MarkedString, Position, SymbolInformation, WorkspaceSymbol } from "./types.ts";

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

const SYMBOL_KIND: Record<number, string> = {
	1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field",
	9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string",
	16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enum-member", 23: "struct",
	24: "event", 25: "operator", 26: "type-parameter",
};

export function severityName(severity: number | undefined): string {
	return SEVERITY[severity ?? 0] ?? "unknown";
}

export function symbolKindName(kind: number): string {
	return SYMBOL_KIND[kind] ?? `kind-${kind}`;
}

export function displayPath(uriOrPath: string, cwd: string): string {
	const path = uriOrPath.startsWith("file:") ? fileURLToPath(uriOrPath) : uriOrPath;
	const rel = relative(cwd, path);
	return rel.startsWith("..") ? path : rel;
}

export function toLspPosition(line: number, column: number): Position {
	return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
}

export function fromLspPosition(position: Position): { line: number; column: number } {
	return { line: position.line + 1, column: position.character + 1 };
}

export function formatDiagnostic(diagnostic: Diagnostic, path: string): string {
	const { line, column } = fromLspPosition(diagnostic.range.start);
	const code = diagnostic.code !== undefined ? ` (${diagnostic.code})` : "";
	const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
	return `${path}:${line}:${column} ${severityName(diagnostic.severity)}: ${diagnostic.message.replace(/\s+/g, " ").trim()}${code}${source}`;
}

export function formatDiagnostics(diagnostics: Diagnostic[], path: string): string {
	if (diagnostics.length === 0) return `No diagnostics for ${path}.`;
	const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9) || a.range.start.line - b.range.start.line);
	return sorted.map((d) => formatDiagnostic(d, path)).join("\n");
}

export function errorsOnly(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.filter((d) => d.severity === 1);
}

function markedToString(item: MarkedString): string {
	return typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``;
}

export function formatHover(hover: Hover | null): string {
	if (!hover) return "No hover information at this position.";
	const contents = hover.contents;
	if (Array.isArray(contents)) return contents.map(markedToString).join("\n\n").trim();
	if (typeof contents === "string") return contents.trim();
	if ("kind" in contents) return contents.value.trim();
	return markedToString(contents).trim();
}

export function formatLocations(locations: Location[], cwd: string, limit: number): string {
	if (locations.length === 0) return "No locations found.";
	const lines = locations.slice(0, limit).map((loc) => {
		const { line, column } = fromLspPosition(loc.range.start);
		return `${displayPath(loc.uri, cwd)}:${line}:${column}`;
	});
	if (locations.length > limit) lines.push(`... ${locations.length - limit} more (${locations.length} total)`);
	return lines.join("\n");
}

function isDocumentSymbol(s: DocumentSymbol | SymbolInformation): s is DocumentSymbol {
	return "selectionRange" in s;
}

export function formatDocumentSymbols(symbols: (DocumentSymbol | SymbolInformation)[], limit: number): string {
	if (symbols.length === 0) return "No symbols found.";
	const lines: string[] = [];
	const walk = (items: (DocumentSymbol | SymbolInformation)[], depth: number) => {
		for (const s of items) {
			if (lines.length >= limit) return;
			const range = isDocumentSymbol(s) ? s.selectionRange : s.location.range;
			const { line } = fromLspPosition(range.start);
			const detail = isDocumentSymbol(s) && s.detail ? ` ${s.detail}` : "";
			lines.push(`${"  ".repeat(depth)}${symbolKindName(s.kind)} ${s.name}${detail} :${line}`);
			if (isDocumentSymbol(s) && s.children?.length) walk(s.children, depth + 1);
		}
	};
	walk(symbols, 0);
	if (lines.length >= limit) lines.push(`... truncated at ${limit} symbols`);
	return lines.join("\n");
}

export function formatWorkspaceSymbols(symbols: WorkspaceSymbol[], cwd: string, limit: number): string {
	if (symbols.length === 0) return "No symbols found.";
	const lines = symbols.slice(0, limit).map((s) => {
		const loc = "range" in s.location ? `${displayPath(s.location.uri, cwd)}:${fromLspPosition(s.location.range.start).line}` : displayPath(s.location.uri, cwd);
		const container = s.containerName ? ` (${s.containerName})` : "";
		return `${symbolKindName(s.kind)} ${s.name}${container} — ${loc}`;
	});
	if (symbols.length > limit) lines.push(`... ${symbols.length - limit} more (${symbols.length} total)`);
	return lines.join("\n");
}
