import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResolvedCommand } from "./registry.ts";

interface TypeScriptPackage {
	directory: string;
	name: string;
	version: string;
	bin: unknown;
}

export function findTypeScriptPackage(root: string, name: string): TypeScriptPackage | undefined {
	for (let dir = resolve(root); ; dir = dirname(dir)) {
		const directory = join(dir, "node_modules", name);
		if (lstatSync(directory, { throwIfNoEntry: false })) {
			let metadata;
			try {
				metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			} catch {
				throw new Error(`Cannot read ${directory}/package.json. Reinstall ${name} in this workspace.`);
			}
			if (metadata?.name !== name || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version)) {
				throw new Error(`Invalid ${name} package at ${directory}. Reinstall it in this workspace.`);
			}
			return { directory, name, version: metadata.version, bin: metadata.bin };
		}
		if (dir === dirname(dir)) return undefined;
	}
}

export function nativeTypeScriptCommand(pkg: TypeScriptPackage, bin: string): ResolvedCommand {
	const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && typeof pkg.bin === "object" && bin in pkg.bin ? Reflect.get(pkg.bin, bin) : undefined;
	const path = typeof entry === "string" && entry ? resolve(pkg.directory, entry) : undefined;
	if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`${pkg.name} ${pkg.version} at ${pkg.directory} has no ${bin} launcher. Reinstall it with optional dependencies enabled.`);
	}
	return { command: process.execPath, args: [path, "--lsp", "--stdio"] };
}
