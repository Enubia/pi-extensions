export const SETTINGS_KEY = "observational-memory";

export const PRESET_RATIOS = [0.1, 0.15, 0.2, 0.25, 0.35, 0.5, 0.68] as const;

export type ParseResult = { ok: true; ratio: number } | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseFactor(input: string): ParseResult {
	const raw = input.trim();
	if (raw.length === 0) return { ok: false, error: "no value given" };
	const percent = raw.endsWith("%");
	const numeric = Number(percent ? raw.slice(0, -1).trim() : raw);
	if (!Number.isFinite(numeric)) return { ok: false, error: `"${raw}" is not a number` };
	const ratio = percent || numeric > 1 ? numeric / 100 : numeric;
	if (!(ratio > 0 && ratio < 1)) return { ok: false, error: `factor must be between 0 and 1 (got ${ratio})` };
	return { ok: true, ratio };
}

export function patchSettings(rawFile: string, provider: string, ratio: number | undefined): string {
	if (!provider.trim()) throw new Error("provider is required");
	if (ratio !== undefined && !(Number.isFinite(ratio) && ratio > 0 && ratio < 1)) {
		throw new Error("factor must be between 0 and 1");
	}
	const parsed = rawFile.trim().length === 0 ? {} : (JSON.parse(rawFile.replace(/^\uFEFF/, "")) as unknown);
	const settings = record(parsed);
	if (!settings) throw new Error("settings.json does not contain a JSON object");
	if (settings[SETTINGS_KEY] !== undefined && !record(settings[SETTINGS_KEY])) {
		throw new Error("observational-memory settings must be an object");
	}
	const nested = { ...record(settings[SETTINGS_KEY]) };
	const existing = nested.compactAfterTokensRatioByProvider;
	if (existing !== undefined && !record(existing)) throw new Error("provider factors must be an object");
	const ratios = { ...record(existing) };
	if (ratio === undefined) delete ratios[provider];
	else Object.defineProperty(ratios, provider, { value: ratio, enumerable: true, configurable: true, writable: true });
	if (Object.keys(ratios).length > 0) nested.compactAfterTokensRatioByProvider = ratios;
	else delete nested.compactAfterTokensRatioByProvider;
	return `${JSON.stringify({ ...settings, [SETTINGS_KEY]: nested }, null, 2)}\n`;
}

export function effectiveThreshold(ratio: number, contextWindow: number | undefined): number | undefined {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return Math.max(1, Math.floor(contextWindow * ratio));
}

export function formatRatio(ratio: number): string {
	return `${(ratio * 100).toFixed(ratio * 100 % 1 === 0 ? 0 : 1)}%`;
}

export function describeThreshold(ratio: number, contextWindow: number | undefined): string {
	const threshold = effectiveThreshold(ratio, contextWindow);
	const label = `factor ${ratio} (${formatRatio(ratio)})`;
	return threshold === undefined
		? `${label}; context window unknown, falling back to compactAfterTokens`
		: `${label} → compact at ~${threshold.toLocaleString()} of ${contextWindow?.toLocaleString()} tokens`;
}

export function presetOptions(contextWindow: number | undefined, current: number | undefined): string[] {
	const ratios = [...PRESET_RATIOS];
	if (current !== undefined && !ratios.includes(current as (typeof PRESET_RATIOS)[number])) {
		ratios.push(current as (typeof PRESET_RATIOS)[number]);
		ratios.sort((a, b) => a - b);
	}
	return ratios.map((ratio) => {
		const threshold = effectiveThreshold(ratio, contextWindow);
		const marker = ratio === current ? " (current)" : "";
		const suffix = threshold === undefined ? "" : ` — ~${threshold.toLocaleString()} tokens`;
		return `${ratio} · ${formatRatio(ratio)}${suffix}${marker}`;
	});
}

export function ratioFromOption(option: string): number | undefined {
	const parsed = parseFactor(option.split("·")[0] ?? "");
	return parsed.ok ? parsed.ratio : undefined;
}
