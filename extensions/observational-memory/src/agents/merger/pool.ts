import { reflectionLineTokenCount } from "../../tokens.js";
import type { Reflection } from "../../session-ledger/index.js";

export type ReflectionPoolMetrics = {
	reflectionTokens: number;
	maxTokens: number;
	targetTokens: number;
	activeReflectionCount: number;
	ready: boolean;
};

export function reflectionTokenSum(reflections: readonly Reflection[]): number {
	return reflections.reduce((sum, reflection) => sum + reflectionLineTokenCount(reflection), 0);
}

export function reflectionPoolMetrics(
	reflections: readonly Reflection[],
	maxTokens: number,
	targetTokens: number,
): ReflectionPoolMetrics {
	const reflectionTokens = reflectionTokenSum(reflections);
	return {
		reflectionTokens,
		maxTokens,
		targetTokens,
		activeReflectionCount: reflections.length,
		ready: reflections.length > 1 && reflectionTokens >= maxTokens,
	};
}
