export const OM_PAUSE_STATUS_KEY = "observational-memory";

export type PausedStage = "obs" | "ref";

const MARKER = "om ⏸";

export function formatPauseStatus(stages: PausedStage[]): string | undefined {
	return stages.length > 0 ? `${MARKER} ${stages.join(" ")}` : undefined;
}

export function parsePauseStatus(status: string | undefined): Set<string> {
	const plain = status?.replace(/\x1b\[[0-9;]*m/g, "").trim();
	if (!plain?.startsWith(MARKER)) return new Set();
	return new Set(plain.slice(MARKER.length).trim().split(/\s+/).filter(Boolean));
}
