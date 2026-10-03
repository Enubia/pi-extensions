import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { displayPath, formatDiagnostics, formatDocumentSymbols, formatHover, formatLocations, formatWorkspaceSymbols, toLspPosition } from "./format.ts";
import { type LspManager, LspUnavailable } from "./manager.ts";

export type ManagerProvider = (ctx: ExtensionContext) => LspManager;

const FileParam = Type.String({ description: "File path, absolute or relative to cwd." });
const LineParam = Type.Number({ description: "1-based line number." });
const ColumnParam = Type.Number({ description: "1-based column; place it on the identifier itself, not on whitespace." });

const LIMIT = 60;

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details };
}

function failure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text" as const, text: message }], isError: true, details: { unavailable: error instanceof LspUnavailable } };
}

export function registerLspTools(pi: ExtensionAPI, getManager: ManagerProvider): void {
	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Compiler/type-checker diagnostics for one file from its language server. Use after editing to confirm the file type-checks, or before editing to understand existing errors.",
		promptSnippet: "Type errors and warnings for a file via its language server",
		promptGuidelines: ["Use lsp_diagnostics after write/edit on source files to verify the change type-checks instead of running the full compiler."],
		parameters: Type.Object({ path: FileParam }),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const { client, absolutePath } = await manager.clientFor(params.path);
				const diagnostics = await client.diagnostics(absolutePath, signal);
				return text(formatDiagnostics(diagnostics, displayPath(absolutePath, manager.cwd)), { count: diagnostics.length });
			} catch (error) {
				return failure(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description: "Type signature and documentation of the symbol at a position, as the compiler sees it.",
		promptSnippet: "Type signature/docs of a symbol at line:column",
		parameters: Type.Object({ path: FileParam, line: LineParam, column: ColumnParam }),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const { client, absolutePath } = await manager.clientFor(params.path);
				return text(formatHover(await client.hover(absolutePath, toLspPosition(params.line, params.column), signal)));
			} catch (error) {
				return failure(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP Definition",
		description: "Locations where the symbol at a position is defined.",
		promptSnippet: "Jump to the definition of a symbol at line:column",
		parameters: Type.Object({ path: FileParam, line: LineParam, column: ColumnParam }),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const { client, absolutePath } = await manager.clientFor(params.path);
				const locations = await client.definition(absolutePath, toLspPosition(params.line, params.column), signal);
				return text(formatLocations(locations, manager.cwd, LIMIT), { count: locations.length });
			} catch (error) {
				return failure(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_references",
		label: "LSP References",
		description: "All references to the symbol at a position across the project. Use before renaming or changing a signature.",
		promptSnippet: "Find all references to a symbol at line:column",
		promptGuidelines: ["Use lsp_references before changing a function signature or renaming a symbol to see every call site."],
		parameters: Type.Object({
			path: FileParam,
			line: LineParam,
			column: ColumnParam,
			includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself. Default false." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const { client, absolutePath } = await manager.clientFor(params.path);
				const locations = await client.references(absolutePath, toLspPosition(params.line, params.column), params.includeDeclaration ?? false, signal);
				return text(formatLocations(locations, manager.cwd, LIMIT), { count: locations.length });
			} catch (error) {
				return failure(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_document_symbols",
		label: "LSP Document Symbols",
		description: "Outline of a file: classes, functions, variables, and their line numbers.",
		promptSnippet: "Outline of the symbols in a file",
		parameters: Type.Object({ path: FileParam }),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const { client, absolutePath } = await manager.clientFor(params.path);
				return text(formatDocumentSymbols(await client.documentSymbols(absolutePath, signal), 200));
			} catch (error) {
				return failure(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_workspace_symbols",
		label: "LSP Workspace Symbols",
		description: "Search symbols by name across the project using running language servers. Pass anchorPath (any file of the target language) to start a server if none is running.",
		promptSnippet: "Search project symbols by name",
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name or prefix." }),
			anchorPath: Type.Optional(Type.String({ description: "A file whose language server should answer, e.g. src/index.ts." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const manager = getManager(ctx);
			try {
				const clients = params.anchorPath ? [(await manager.clientFor(params.anchorPath)).client] : manager.readyClients();
				if (clients.length === 0) return failure(new LspUnavailable("No language server is running. Pass anchorPath to start one."));
				const results = await Promise.all(clients.map((c) => c.workspaceSymbols(params.query, signal).catch(() => [])));
				return text(formatWorkspaceSymbols(results.flat(), manager.cwd, LIMIT));
			} catch (error) {
				return failure(error);
			}
		},
	});
}
