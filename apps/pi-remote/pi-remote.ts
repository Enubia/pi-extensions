#!/usr/bin/env node
import { parseCliArgs, realDeps, remoteDirectory, startPiRemote, type RunningHub } from "./cli.ts";

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	let running: RunningHub | undefined;
	const controller = new AbortController();
	let quitting = false;
	const quit = async () => {
		if (quitting) return;
		quitting = true;
		if (!running) {
			controller.abort();
			return;
		}
		await running.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void quit());
	process.on("SIGTERM", () => void quit());
	try {
		running = await startPiRemote({ ...options, dir: remoteDirectory(), signal: controller.signal }, realDeps(() => void quit()));
	} catch (error) {
		if (controller.signal.aborted) process.exit(0);
		throw error;
	}
}

main().catch((error: unknown) => {
	console.error(`pi-remote: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
