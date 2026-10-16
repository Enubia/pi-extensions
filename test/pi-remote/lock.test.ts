import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, AlreadyRunningError, LOCK_FILE_NAME } from "../../apps/pi-remote/lock.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-remote-lock-"));
}

test("writes pid and removes the lock on release", () => {
	const dir = tempDir();
	try {
		const lock = acquireLock(dir);
		assert.equal(readFileSync(join(dir, LOCK_FILE_NAME), "utf8").trim(), String(process.pid));
		lock.release();
		assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), false);
		lock.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses a second instance while the owner is alive", () => {
	const dir = tempDir();
	try {
		const lock = acquireLock(dir);
		assert.throws(
			() => acquireLock(dir),
			(error) => error instanceof AlreadyRunningError && error.pid === process.pid && /already running, pid \d+/.test(error.message),
		);
		lock.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("takes over a lock whose owner is dead or whose content is garbage", () => {
	const dir = tempDir();
	try {
		writeFileSync(join(dir, LOCK_FILE_NAME), "999999999\n");
		acquireLock(dir).release();
		writeFileSync(join(dir, LOCK_FILE_NAME), "not a pid");
		const lock = acquireLock(dir);
		assert.equal(readFileSync(join(dir, LOCK_FILE_NAME), "utf8").trim(), String(process.pid));
		lock.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("release leaves a lock owned by someone else", () => {
	const dir = tempDir();
	try {
		const lock = acquireLock(dir);
		writeFileSync(join(dir, LOCK_FILE_NAME), "1\n");
		lock.release();
		assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
