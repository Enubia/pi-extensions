import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResolvedCommand {
	command: string;
	args: string[];
}

export interface ResolveContext {
	root: string;
	which: (bin: string) => string | undefined;
}

export interface ServerSpec {
	id: string;
	languageIds: Record<string, string>;
	rootMarkers: string[];
	resolve: (ctx: ResolveContext) => ResolvedCommand | undefined;
	initializationOptions?: unknown;
	settings?: unknown;
	diagnosticsSettleMs?: number;
	diagnosticsMaxWaitMs?: number;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export interface UserServerConfig {
	id: string;
	enabled?: boolean;
	extensions: Record<string, string>;
	rootMarkers?: string[];
	bin: string;
	args?: string[];
	initializationOptions?: unknown;
	settings?: unknown;
	diagnosticsSettleMs?: number;
	diagnosticsMaxWaitMs?: number;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export interface UserConfig {
	servers?: UserServerConfig[];
	disabled?: string[];
}

function localBin(root: string, name: string): string | undefined {
	const candidate = join(root, "node_modules", ".bin", name);
	return existsSync(candidate) ? candidate : undefined;
}

const TS_LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
};

export const typescriptSpec: ServerSpec = {
	id: "typescript",
	languageIds: TS_LANGUAGE_IDS,
	rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	resolve: ({ root, which }) => {
		const hasTsserver = existsSync(join(root, "node_modules", "typescript", "lib", "tsserver.js"));
		const localTsc = localBin(root, "tsc");
		if (!hasTsserver && localTsc) return { command: localTsc, args: ["--lsp", "--stdio"] };
		const tsls = localBin(root, "typescript-language-server") ?? which("typescript-language-server");
		if (tsls) return { command: tsls, args: ["--stdio"] };
		if (localTsc) return { command: localTsc, args: ["--lsp", "--stdio"] };
		const globalTsgo = which("tsgo");
		if (globalTsgo) return { command: globalTsgo, args: ["--lsp", "--stdio"] };
		return undefined;
	},
	diagnosticsSettleMs: 500,
	diagnosticsMaxWaitMs: 8_000,
};

export const goSpec: ServerSpec = {
	id: "go",
	languageIds: { ".go": "go" },
	rootMarkers: ["go.work", "go.mod"],
	resolve: ({ which }) => {
		const gopls = which("gopls");
		return gopls ? { command: gopls, args: [] } : undefined;
	},
	diagnosticsSettleMs: 1_000,
	diagnosticsMaxWaitMs: 15_000,
};

export const rustSpec: ServerSpec = {
	id: "rust",
	languageIds: { ".rs": "rust" },
	rootMarkers: ["Cargo.toml"],
	resolve: ({ which }) => {
		const ra = which("rust-analyzer");
		return ra ? { command: ra, args: [] } : undefined;
	},
	diagnosticsSettleMs: 2_000,
	diagnosticsMaxWaitMs: 60_000,
	startupTimeoutMs: 60_000,
};

export const pythonSpec: ServerSpec = {
	id: "python",
	languageIds: { ".py": "python", ".pyi": "python" },
	rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
	resolve: ({ root, which }) => {
		const bin = localBin(root, "pyright-langserver") ?? which("pyright-langserver");
		return bin ? { command: bin, args: ["--stdio"] } : undefined;
	},
	diagnosticsSettleMs: 1_000,
	diagnosticsMaxWaitMs: 15_000,
};

export const builtinSpecs: ServerSpec[] = [typescriptSpec, goSpec, rustSpec, pythonSpec];

export function specFromUserConfig(config: UserServerConfig): ServerSpec {
	return {
		id: config.id,
		languageIds: config.extensions,
		rootMarkers: config.rootMarkers ?? [],
		resolve: ({ root, which }) => {
			const bin = config.bin.replace("{root}", root);
			const command = bin.includes("/") ? bin : which(bin);
			return command ? { command, args: config.args ?? [] } : undefined;
		},
		initializationOptions: config.initializationOptions,
		settings: config.settings,
		diagnosticsSettleMs: config.diagnosticsSettleMs,
		diagnosticsMaxWaitMs: config.diagnosticsMaxWaitMs,
		startupTimeoutMs: config.startupTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
	};
}

export function mergeSpecs(builtin: ServerSpec[], user: UserConfig | undefined): ServerSpec[] {
	const disabled = new Set(user?.disabled ?? []);
	const byId = new Map(builtin.map((s) => [s.id, s]));
	for (const entry of user?.servers ?? []) {
		if (entry.enabled === false) {
			disabled.add(entry.id);
			continue;
		}
		byId.set(entry.id, specFromUserConfig(entry));
	}
	return [...byId.values()].filter((s) => !disabled.has(s.id));
}

export function extensionOf(filePath: string): string {
	const match = /\.[^./\\]+$/.exec(filePath);
	return match ? match[0].toLowerCase() : "";
}

export function specForFile(specs: ServerSpec[], filePath: string): ServerSpec | undefined {
	const ext = extensionOf(filePath);
	return specs.find((s) => ext in s.languageIds);
}

export function languageIdFor(spec: ServerSpec, filePath: string): string {
	return spec.languageIds[extensionOf(filePath)] ?? "plaintext";
}

export function findRoot(filePath: string, markers: string[], stopAt: string): string {
	let dir = dirname(filePath);
	let fallback = stopAt;
	for (;;) {
		if (markers.some((m) => existsSync(join(dir, m)))) return dir;
		if (dir === stopAt || dir === dirname(dir)) break;
		dir = dirname(dir);
	}
	if (!filePath.startsWith(stopAt)) fallback = dirname(filePath);
	return fallback;
}
