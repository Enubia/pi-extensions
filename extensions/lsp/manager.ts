import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { LspClient } from "./client.ts";
import { type ServerSpec, type UserConfig, builtinSpecs, findRoot, mergeSpecs, specForFile } from "./registry.ts";

export interface ManagerOptions {
	cwd: string;
	specs?: ServerSpec[];
	warnings?: string[];
	which?: (bin: string) => string | undefined;
	isProjectTrusted?: () => boolean;
}

export interface ResolvedTarget {
	spec: ServerSpec;
	root: string;
	absolutePath: string;
}

export class LspUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspUnavailable";
	}
}

export function whichOnPath(bin: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export interface LoadedUserConfig {
	config: UserConfig | undefined;
	warnings: string[];
}

export function loadUserConfig(paths: string[]): LoadedUserConfig {
	let merged: UserConfig | undefined;
	const warnings: string[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as UserConfig;
			merged = {
				servers: [...(merged?.servers ?? []), ...(parsed.servers ?? [])],
				disabled: [...(merged?.disabled ?? []), ...(parsed.disabled ?? [])],
			};
		} catch (error) {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { config: merged, warnings };
}

export class LspManager {
	readonly cwd: string;
	readonly specs: ServerSpec[];
	readonly warnings: string[];
	private readonly failures = new Map<string, string>();
	private readonly which: (bin: string) => string | undefined;
	private readonly isProjectTrusted: () => boolean;
	private readonly clients = new Map<string, LspClient>();

	constructor(options: ManagerOptions) {
		this.cwd = options.cwd;
		this.specs = options.specs ?? builtinSpecs;
		this.warnings = options.warnings ?? [];
		this.which = options.which ?? whichOnPath;
		this.isProjectTrusted = options.isProjectTrusted ?? (() => true);
	}

	static fromConfig(options: Omit<ManagerOptions, "specs" | "warnings"> & { configPaths: string[] }): LspManager {
		const loaded = loadUserConfig(options.configPaths);
		return new LspManager({ ...options, specs: mergeSpecs(builtinSpecs, loaded.config), warnings: loaded.warnings });
	}

	resolveTarget(filePath: string): ResolvedTarget | undefined {
		const absolutePath = isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath);
		const spec = specForFile(this.specs, absolutePath);
		if (!spec) return undefined;
		const root = findRoot(absolutePath, spec.rootMarkers, this.cwd);
		return { spec, root, absolutePath };
	}

	runningClientFor(filePath: string): LspClient | undefined {
		const target = this.resolveTarget(filePath);
		if (!target) return undefined;
		const client = this.clients.get(this.key(target));
		return client?.state === "ready" ? client : undefined;
	}

	async clientFor(filePath: string): Promise<{ client: LspClient; absolutePath: string }> {
		const target = this.resolveTarget(filePath);
		if (!target) throw new LspUnavailable(`No language server configured for ${filePath}`);
		const client = await this.ensureClient(target);
		return { client, absolutePath: target.absolutePath };
	}

	async ensureClient(target: ResolvedTarget): Promise<LspClient> {
		const key = this.key(target);
		const existing = this.clients.get(key);
		if (existing && existing.state !== "failed" && existing.state !== "stopped") {
			await existing.whenReady();
			return existing;
		}
		if (existing) {
			this.failures.set(key, existing.lastError ?? "exited");
			this.clients.delete(key);
			void existing.dispose();
		}
		const failure = this.failures.get(key);
		if (failure) throw new LspUnavailable(`${target.spec.id} server failed for ${target.root}: ${failure}. Use /lsp restart to retry.`);
		if (!this.isProjectTrusted()) throw new LspUnavailable("Project is not trusted; refusing to spawn a language server.");
		const command = target.spec.resolve({ root: target.root, which: this.which });
		if (!command) throw new LspUnavailable(`No ${target.spec.id} language server binary found for ${target.root}.`);
		const client = new LspClient(target.spec, target.root, command);
		this.clients.set(key, client);
		try {
			await client.whenReady();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failures.set(key, message);
			this.clients.delete(key);
			await client.dispose();
			throw new LspUnavailable(`${target.spec.id} failed to start (${command.command} ${command.args.join(" ")}): ${message}`);
		}
		return client;
	}

	warm(target: ResolvedTarget): void {
		void this.ensureClient(target)
			.then((client) => client.sync(target.absolutePath))
			.catch(() => undefined);
	}

	failedServers(): string[] {
		return [...this.failures.entries()].map(([key, message]) => `${key.replace("\u0000", " @ ")}: ${message}`);
	}

	readyClients(): LspClient[] {
		return [...this.clients.values()].filter((c) => c.state === "ready");
	}

	allClients(): LspClient[] {
		return [...this.clients.values()];
	}

	async restart(specId?: string): Promise<number> {
		let count = 0;
		for (const key of [...this.failures.keys()]) {
			if (!specId || key.startsWith(`${specId}\u0000`)) this.failures.delete(key);
		}
		for (const [key, client] of [...this.clients.entries()]) {
			if (specId && client.spec.id !== specId) continue;
			await client.dispose();
			this.clients.delete(key);
			count += 1;
		}
		return count;
	}

	async dispose(): Promise<void> {
		await Promise.allSettled([...this.clients.values()].map((c) => c.dispose()));
		this.clients.clear();
	}

	private key(target: ResolvedTarget): string {
		return `${target.spec.id}\u0000${target.root}`;
	}
}
