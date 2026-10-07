import type { Observation } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";

export function selectPriorObservations(
	observations: readonly Observation[],
	maxTokens: number | false,
): { observations: Observation[]; omitted: number } {
	if (maxTokens === false) return { observations: [...observations], omitted: 0 };
	let used = 0;
	let keepFrom = observations.length;
	while (keepFrom > 0) {
		const next = used + observationLineTokenCount(observations[keepFrom - 1]);
		if (next > maxTokens) break;
		used = next;
		keepFrom--;
	}
	return { observations: observations.slice(keepFrom), omitted: keepFrom };
}

export function priorObservationsOmittedLine(omitted: number): string {
	return `(${omitted} older observation${omitted === 1 ? "" : "s"} omitted; only the most recent are shown)`;
}
