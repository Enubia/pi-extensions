import { debugLog } from "../debug-log.js";
import { WorkerStreamError } from "./stream-errors.js";

export const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_JITTER_RATIO = 0.2;

export function isRetryableError(error: unknown): boolean {
	if (error instanceof WorkerStreamError) {
		return error.stopReason === "error" && RETRYABLE_ERROR_RE.test(error.errorMessage ?? "");
	}
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	return RETRYABLE_ERROR_RE.test(error.message);
}

export function retryDelayMs(retryNumber: number, random: () => number = Math.random): number {
	const base = RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1);
	return Math.round(base * (1 + (random() * 2 - 1) * RETRY_JITTER_RATIO));
}

export type RetryOptions = {
	stage: string;
	maxRetries: number;
	canContinue: () => boolean;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withAttemptCount(error: unknown, attempts: number): unknown {
	if (attempts > 1 && error instanceof Error) error.message = `${error.message} (after ${attempts} attempts)`;
	return error;
}

export async function withRetries<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
	const sleep = options.sleep ?? defaultSleep;
	let attempt = 1;
	for (;;) {
		try {
			return await run();
		} catch (error) {
			if (attempt > options.maxRetries || !isRetryableError(error)) throw withAttemptCount(error, attempt);
			const delayMs = retryDelayMs(attempt, options.random);
			debugLog(`${options.stage}.retry`, {
				attempt,
				maxRetries: options.maxRetries,
				delayMs,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			await sleep(delayMs);
			if (!options.canContinue()) throw withAttemptCount(error, attempt);
			attempt++;
		}
	}
}
