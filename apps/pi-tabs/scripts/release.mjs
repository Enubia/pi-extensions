import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const tagPrefix = "pi-tabs-v";
const git = (...args) => execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();

const pkgPath = path.join(appDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const lastTag = `${tagPrefix}${pkg.version}`;
git("rev-parse", "--verify", "--quiet", `refs/tags/${lastTag}`);

const log = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", `${lastTag}..HEAD`, "--", ".");
const commits = log
	.split("\x1e")
	.map((entry) => entry.trim())
	.filter(Boolean)
	.map((entry) => {
		const [hash, subject, body] = entry.split("\x1f");
		const match = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
		return {
			hash: hash.slice(0, 7),
			type: match?.[1] ?? "other",
			text: (match?.[4] ?? subject).replace(/\s*\[skip ci\]/gi, ""),
			breaking: Boolean(match?.[3]) || /BREAKING CHANGE/.test(body),
		};
	});

const output = (key, value) => {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	console.log(`${key}=${value}`);
};

if (commits.length === 0) {
	output("released", "false");
	process.exit(0);
}

const override = process.env.RELEASE_BUMP;
const bump =
	override && override !== "auto"
		? override
		: commits.some((c) => c.breaking)
			? "major"
			: commits.some((c) => c.type === "feat")
				? "minor"
				: "patch";

const [major, minor, patch] = pkg.version.split(".").map(Number);
const version =
	bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const sections = [
	["Breaking changes", (c) => c.breaking],
	["Features", (c) => !c.breaking && c.type === "feat"],
	["Fixes", (c) => !c.breaking && (c.type === "fix" || c.type === "perf")],
	["Other", (c) => !c.breaking && !["feat", "fix", "perf"].includes(c.type)],
];
const repoUrl = "https://github.com/Enubia/pi-extensions";
const notes = sections
	.map(([title, test]) => {
		const items = commits.filter(test);
		if (items.length === 0) return "";
		return `### ${title}\n\n${items.map((c) => `- ${c.text} ([${c.hash}](${repoUrl}/commit/${c.hash}))`).join("\n")}\n`;
	})
	.filter(Boolean)
	.join("\n");

const date = new Date().toISOString().slice(0, 10);
const changelogPath = path.join(appDir, "CHANGELOG.md");
const header = "# Changelog\n\n";
const previous = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8").replace(header, "") : "";
writeFileSync(changelogPath, `${header}## ${version} (${date})\n\n${notes}\n${previous}`);

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const lockPath = path.join(appDir, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

writeFileSync(path.join(appDir, "RELEASE_NOTES.md"), notes);
output("released", "true");
output("version", version);
output("tag", `${tagPrefix}${version}`);
