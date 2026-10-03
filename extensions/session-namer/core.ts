export interface NamerConfig {
	enabled: boolean;
	provider?: string;
	model?: string;
	thinking?: string;
	refreshEvery: number;
	maxNameLength: number;
	maxTranscriptChars: number;
	notify: boolean;
}

export const DEFAULT_CONFIG: NamerConfig = {
	enabled: true,
	refreshEvery: 5,
	maxNameLength: 60,
	maxTranscriptChars: 12000,
	notify: false,
};

export const FALLBACK_MODELS: { provider: string; model: string }[] = [
	{ provider: "openai-codex", model: "gpt-5.6-luna" },
	{ provider: "openai", model: "gpt-5.6-luna" },
	{ provider: "anthropic", model: "claude-haiku-4-5" },
	{ provider: "openai", model: "gpt-5-nano" },
];

const positiveInt = (value: unknown, fallback: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : fallback;
};

export const parseConfig = (raw: unknown): NamerConfig => {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const source = raw as Record<string, unknown>;
	const model = source.model;
	const nested = model && typeof model === "object" ? (model as Record<string, unknown>) : undefined;

	return {
		enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled !== false,
		provider: typeof source.provider === "string" ? source.provider : typeof nested?.provider === "string" ? nested.provider : undefined,
		model: typeof model === "string" ? model : typeof nested?.id === "string" ? nested.id : undefined,
		thinking: typeof source.thinking === "string" ? source.thinking : typeof nested?.thinking === "string" ? nested.thinking : undefined,
		refreshEvery: positiveInt(source.refreshEvery, DEFAULT_CONFIG.refreshEvery),
		maxNameLength: positiveInt(source.maxNameLength, DEFAULT_CONFIG.maxNameLength),
		maxTranscriptChars: positiveInt(source.maxTranscriptChars, DEFAULT_CONFIG.maxTranscriptChars),
		notify: source.notify === true,
	};
};

export const readConfig = (settingsJson: string, key = "session-namer"): NamerConfig => {
	try {
		const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
		return parseConfig(parsed?.[key]);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

export interface ModelRef {
	provider: string;
	id: string;
}

export const parseModelRef = (text: string): ModelRef | undefined => {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();
	if (!provider || !id || /\s/.test(provider) || /\s/.test(id)) return undefined;
	return { provider, id };
};

export const formatModelRef = (ref: ModelRef | undefined): string => (ref ? `${ref.provider}/${ref.id}` : "auto");

export const patchSettingsModel = (settingsJson: string, ref: ModelRef | undefined, key = "session-namer"): string => {
	let parsed: Record<string, unknown> = {};
	try {
		const candidate = JSON.parse(settingsJson || "{}");
		if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
	} catch {
		throw new Error("settings.json is not valid JSON");
	}

	const existing = parsed[key];
	const block: Record<string, unknown> = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
	const previous = block.model;
	const thinking = typeof block.thinking === "string"
		? block.thinking
		: previous && typeof previous === "object" && typeof (previous as Record<string, unknown>).thinking === "string"
			? ((previous as Record<string, unknown>).thinking as string)
			: undefined;

	delete block.provider;
	delete block.thinking;
	if (ref) block.model = thinking ? { provider: ref.provider, id: ref.id, thinking } : { provider: ref.provider, id: ref.id };
	else delete block.model;

	parsed[key] = block;
	return `${JSON.stringify(parsed, null, 2)}\n`;
};

export const sanitizeName = (raw: string | undefined, maxLength: number): string | undefined => {
	if (!raw) return undefined;
	let name = raw.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
	name = name.replace(/^(?:title|name|session)\s*[:\-]\s*/i, "");
	name = name.replace(/^["'`*_\s]+|["'`*_\s.]+$/g, "");
	name = name.replace(/\s+/g, " ").trim();
	if (!name) return undefined;
	if (name.length > maxLength) {
		const cut = name.slice(0, maxLength);
		const lastSpace = cut.lastIndexOf(" ");
		name = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
	}
	return name || undefined;
};

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface TranscriptEntry {
	type?: string;
	message?: { role?: string; content?: unknown };
}

const blocksOf = (content: unknown): ContentBlock[] => {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is ContentBlock => !!part && typeof part === "object");
};

export const buildTranscript = (entries: readonly unknown[], maxChars: number): string => {
	const sections: string[] = [];

	for (const candidate of entries) {
		const entry = candidate as TranscriptEntry;
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;

		const lines: string[] = [];
		const texts: string[] = [];
		const tools: string[] = [];

		for (const block of blocksOf(entry.message?.content)) {
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
			else if (block.type === "toolCall" && typeof block.name === "string") tools.push(block.name);
		}

		const text = texts.join("\n").trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		if (role === "assistant" && tools.length > 0) lines.push(`Tools used: ${[...new Set(tools)].join(", ")}`);
		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	const transcript = sections.join("\n\n");
	if (transcript.length <= maxChars) return transcript;

	const headChars = Math.floor(maxChars * 0.6);
	const tailChars = maxChars - headChars;
	return `${transcript.slice(0, headChars)}\n\n[...truncated...]\n\n${transcript.slice(-tailChars)}`;
};

export const buildPrompt = (transcript: string, currentName?: string): string =>
	[
		"You name coding-agent sessions so they can be found again later.",
		"",
		"Return ONLY the name. No quotes, no punctuation at the end, no explanation.",
		"Rules:",
		"- 3 to 8 words, Title Case-ish but natural",
		"- describe the concrete task or subject, not the process (bad: 'Assistant Helps User')",
		"- keep any ticket, issue, or PR identifier that appears (e.g. 'ISSUE-191', '#204') as a prefix",
		"- prefer the dominant topic if the session drifted",
		currentName ? `\nThe current name is "${currentName}". Keep it verbatim if it still fits; otherwise replace it.` : "",
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	]
		.filter((line) => line !== "")
		.join("\n");

export interface NameDecisionInput {
	enabled: boolean;
	hasSession: boolean;
	manualName: boolean;
	currentName?: string;
	ownedName?: string;
	settledSinceName: number;
	refreshEvery: number;
	inFlight: boolean;
}

export type NameDecision = "generate" | "refresh" | "skip";

export const decideNaming = (input: NameDecisionInput): NameDecision => {
	if (!input.enabled || !input.hasSession || input.inFlight) return "skip";
	if (input.currentName && input.currentName !== input.ownedName) return "skip";
	if (input.manualName) return "skip";
	if (!input.currentName) return "generate";
	return input.settledSinceName >= input.refreshEvery ? "refresh" : "skip";
};
