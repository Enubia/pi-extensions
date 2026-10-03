import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const PACKAGE_DIRS = {
	"@earendil-works/pi-coding-agent": ".",
	"@earendil-works/pi-ai": "node_modules/@earendil-works/pi-ai",
	"@earendil-works/pi-tui": "node_modules/@earendil-works/pi-tui",
	"@earendil-works/pi-agent-core": "node_modules/@earendil-works/pi-agent-core",
	typebox: "node_modules/typebox",
};
const ROOT_SUBPATH_OVERRIDES = { "@earendil-works/pi-ai": "./compat" };

function readPackageJson(dir) {
	const file = join(dir, "package.json");
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function isHostRoot(dir) {
	return readPackageJson(dir)?.name === HOST_PACKAGE;
}

function workspaceCandidates(cwd) {
	const candidates = [];
	let dir = resolve(cwd);
	for (;;) {
		candidates.push(join(dir, "node_modules", HOST_PACKAGE));
		const parent = dirname(dir);
		if (parent === dir) return candidates;
		dir = parent;
	}
}

function installationCandidates(execPath) {
	const binDir = dirname(resolve(execPath));
	const installDir = dirname(binDir);
	return [join(installDir, "lib", "node_modules", HOST_PACKAGE), join(installDir, "node_modules", HOST_PACKAGE)];
}

export function resolveHostRoot({ env = process.env, execPath = process.execPath, cwd = process.cwd() } = {}) {
	const override = env.PI_TEST_HOST_ROOT;
	if (override) {
		const dir = resolve(override);
		if (!isHostRoot(dir)) throw new Error(`PI_TEST_HOST_ROOT does not point at an installed ${HOST_PACKAGE}: ${dir}`);
		return dir;
	}
	for (const candidate of [...workspaceCandidates(cwd), ...installationCandidates(execPath)]) {
		if (isHostRoot(candidate)) return candidate;
	}
	throw new Error(
		`Unable to locate ${HOST_PACKAGE}. Run npm ci at the package root or set PI_TEST_HOST_ROOT for installed-host integration tests.`,
	);
}

function parseSpecifier(specifier) {
	const canonical = specifier;
	const segments = canonical.split("/");
	const name = canonical.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
	const packageDir = PACKAGE_DIRS[name];
	if (!packageDir) return undefined;
	const rest = segments.slice(canonical.startsWith("@") ? 2 : 1);
	const subpath = rest.length === 0 ? (ROOT_SUBPATH_OVERRIDES[name] ?? ".") : `./${rest.join("/")}`;
	return { packageDir, subpath };
}

function exportTarget(exports, subpath) {
	if (!exports) return undefined;
	const entry = typeof exports === "string" ? (subpath === "." ? exports : undefined) : exports[subpath];
	if (!entry) return undefined;
	if (typeof entry === "string") return entry;
	return entry.import ?? entry.default;
}

export function resolveHostModule(specifier, hostRoot) {
	const parsed = parseSpecifier(specifier);
	if (!parsed) return undefined;
	let packageDir = join(hostRoot, parsed.packageDir);
	let pkg = readPackageJson(packageDir);
	if (!pkg) {
		let parent = dirname(hostRoot);
		for (;;) {
			const candidate = join(parent, parsed.packageDir);
			pkg = readPackageJson(candidate);
			if (pkg) { packageDir = candidate; break; }
			const next = dirname(parent);
			if (next === parent) return undefined;
			parent = next;
		}
	}
	const target = exportTarget(pkg.exports, parsed.subpath) ?? (parsed.subpath === "." ? pkg.main : undefined);
	if (!target) return undefined;
	return pathToFileURL(join(packageDir, target)).href;
}
