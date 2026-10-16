import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE_NAME = "pi-remote.lock";

export class AlreadyRunningError extends Error {
	pid: number;

	constructor(pid: number) {
		super(`pi-remote is already running, pid ${pid}`);
		this.pid = pid;
	}
}

export type Lock = { release(): void };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readOwner(path: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function acquireLock(dir: string): Lock {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, LOCK_FILE_NAME);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
			return {
				release() {
					if (readOwner(path) !== process.pid) return;
					try {
						unlinkSync(path);
					} catch {}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = readOwner(path);
		if (owner !== undefined && isAlive(owner)) throw new AlreadyRunningError(owner);
		try {
			unlinkSync(path);
		} catch {}
	}
	throw new Error(`could not acquire ${path}`);
}
