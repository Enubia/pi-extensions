export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange?: Range;
}

export interface Diagnostic {
	range: Range;
	severity?: 1 | 2 | 3 | 4;
	code?: number | string;
	source?: string;
	message: string;
}

export interface DocumentDiagnosticReport {
	kind: "full" | "unchanged";
	items: Diagnostic[];
	resultId?: string;
}

export type MarkupContent = { kind: "markdown" | "plaintext"; value: string };
export type MarkedString = string | { language: string; value: string };

export interface Hover {
	contents: MarkupContent | MarkedString | MarkedString[];
	range?: Range;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
	containerName?: string;
}

export interface WorkspaceSymbol {
	name: string;
	kind: number;
	location: Location | { uri: string };
	containerName?: string;
}

export interface ServerCapabilities {
	hoverProvider?: unknown;
	definitionProvider?: unknown;
	referencesProvider?: unknown;
	documentSymbolProvider?: unknown;
	workspaceSymbolProvider?: unknown;
	diagnosticProvider?: unknown;
	[key: string]: unknown;
}
