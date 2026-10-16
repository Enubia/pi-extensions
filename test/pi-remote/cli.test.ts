import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCliArgs, parseDuration, startPiRemote, type StartDeps } from "../../apps/pi-remote/cli.ts";
import { LOCK_FILE_NAME } from "../../apps/pi-remote/lock.ts";
import { startFakeSession, waitFor } from "./fake-session.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-remote-cli-"));
}

function deps(output: string[], killed: number[] = []): StartDeps {
	return {
		print: (line) => output.push(line),
		lanAddress: () => "192.168.1.50",
		localHostName: () => "my-mac",
		renderQr: (url, done) => done(`QR[${url}]`),
		spawnCaffeinate: (pid) => ({ kill: () => void killed.push(pid) }),
	};
}

test("parses durations", () => {
	assert.equal(parseDuration("90s"), 90_000);
	assert.equal(parseDuration("30m"), 1_800_000);
	assert.equal(parseDuration("2h"), 7_200_000);
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.equal(parseDuration("45"), 2_700_000);
	for (const bad of ["", "abc", "0", "-5m", "1x"]) assert.equal(parseDuration(bad), undefined, bad);
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([]), { port: 7317, forMs: undefined });
	assert.deepEqual(parseCliArgs(["--port", "9000", "--for", "2h"]), { port: 9000, forMs: 7_200_000 });
	assert.throws(() => parseCliArgs(["--port", "nope"]), /port/);
	assert.throws(() => parseCliArgs(["--port", "70000"]), /port/);
	assert.throws(() => parseCliArgs(["--for", "zzz"]), /--for/);
});

test("starts, prints urls and qr, then stops cleanly", async () => {
	const dir = tempDir();
	const output: string[] = [];
	const killed: number[] = [];
	try {
		const running = await startPiRemote({ port: 0, forMs: undefined, dir }, deps(output, killed));
		const text = output.join("\n");
		assert.match(text, new RegExp(`QR\\[http://192\\.168\\.1\\.50:${running.port}/#t=${running.token}\\]`));
		assert.match(text, new RegExp(`http://192\\.168\\.1\\.50:${running.port}/#t=${running.token}`));
		assert.match(text, new RegExp(`http://my-mac\\.local:${running.port}/#t=${running.token}`));
		assert.equal(running.token.length, 43);
		assert.deepEqual(killed, []);
		assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), true);
		const response = await fetch(`http://127.0.0.1:${running.port}/`);
		assert.equal(response.status, 200);
		await running.stop();
		assert.deepEqual(killed, [process.pid]);
		assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), false);
		await assert.rejects(fetch(`http://127.0.0.1:${running.port}/`));
		await running.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("second instance fails with already running, pid", async () => {
	const dir = tempDir();
	try {
		const first = await startPiRemote({ port: 0, forMs: undefined, dir }, deps([]));
		await assert.rejects(startPiRemote({ port: 0, forMs: undefined, dir }, deps([])), new RegExp(`already running, pid ${process.pid}`));
		await first.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("busy port gives a clear error and leaves no lock", async () => {
	const dir = tempDir();
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(0, resolve));
	const port = (blocker.address() as AddressInfo).port;
	try {
		await assert.rejects(startPiRemote({ port, forMs: undefined, dir }, deps([])), new RegExp(`port ${port} is already in use`));
		assert.equal(existsSync(join(dir, LOCK_FILE_NAME)), false);
	} finally {
		blocker.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--for auto-quits via onExpire", async () => {
	const dir = tempDir();
	try {
		let expired = false;
		const running = await startPiRemote({ port: 0, forMs: 30, dir }, { ...deps([]), onExpire: () => void (expired = true) });
		await waitFor(() => expired);
		await running.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discovers sessions in the configured dir", async () => {
	const dir = tempDir();
	const fake = await startFakeSession(dir, 4242, { hello: { label: "found" } });
	try {
		const running = await startPiRemote({ port: 0, forMs: undefined, dir }, deps([]));
		const response = await fetch(`http://127.0.0.1:${running.port}/events?t=${running.token}`);
		const reader = response.body?.getReader();
		let text = "";
		const decoder = new TextDecoder();
		while (reader && !text.includes('"label":"found"')) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
		assert.match(text, /"label":"found"/);
		await running.stop();
	} finally {
		await fake.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
