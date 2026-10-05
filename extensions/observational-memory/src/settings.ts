import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export function updateSettingsFile(path: string, patch: (raw: string) => string): void {
	mkdirSync(dirname(path), { recursive: true });
	const release = lockfile.lockSync(path, { realpath: false });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const exists = existsSync(path);
		const contents = patch(exists ? readFileSync(path, "utf8") : "");
		writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: exists ? statSync(path).mode & 0o777 : 0o600 });
		renameSync(temp, path);
	} finally {
		try {
			rmSync(temp, { force: true });
		} finally {
			release();
		}
	}
}
