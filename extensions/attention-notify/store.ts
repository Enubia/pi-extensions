import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionRecord } from "./core.ts";

export function writeAttentionRecord(directory: string, fileName: string, attention: AttentionRecord | undefined): void {
	if (!existsSync(directory)) return;
	const path = join(directory, fileName);
	try {
		if (!attention) {
			rmSync(path, { force: true });
			return;
		}
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(attention));
		renameSync(temporary, path);
	} catch {}
}
