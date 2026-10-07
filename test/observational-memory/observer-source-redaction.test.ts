import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../../extensions/observational-memory/src/config.js";
import {
	renderRecallSourceEntry,
	serializeSourceAddressedBranchEntries,
	type RenderableEntry,
} from "../../extensions/observational-memory/src/serialize.js";

function assistantCall(id: string, callId: string, name: string, args: Record<string, unknown>): RenderableEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1_700_000_000_000 },
	};
}

function result(id: string, callId: string, toolName: string, text: string): RenderableEntry {
	return {
		type: "message",
		id,
		message: { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], timestamp: 1_700_000_000_000 },
	};
}

const SKILL_TEXT = "# Skill\nlots of instructions";

describe("observer skill read redaction", () => {
	it("omits SKILL.md read content but keeps the tool call line", () => {
		const entries = [
			assistantCall("a1", "c1", "read", { path: "/home/u/proj/tools/SKILL.md" }),
			result("r1", "c1", "read", SKILL_TEXT),
		];
		const out = serializeSourceAddressedBranchEntries(entries, { redactSkillReads: true, toolCallEntries: entries });
		expect(out.text).toContain('[read({"path":"/home/u/proj/tools/SKILL.md"})]');
		expect(out.text).toContain("]: [skill file /home/u/proj/tools/SKILL.md loaded; content omitted]");
		expect(out.text).not.toContain("lots of instructions");
		expect(out.redactedSourceEntryIds).toEqual(["r1"]);
	});

	it("omits reads under any skills/ directory segment", () => {
		const entries = [
			assistantCall("a1", "c1", "read", { path: "/home/u/.pi/agent/skills/tdd/tests.md" }),
			result("r1", "c1", "read", "tdd tests"),
			assistantCall("a2", "c2", "read", { path: ".pi/skills/x/ref.md" }),
			result("r2", "c2", "read", "project ref"),
		];
		const out = serializeSourceAddressedBranchEntries(entries, { redactSkillReads: true, toolCallEntries: entries });
		expect(out.text).not.toContain("tdd tests");
		expect(out.text).not.toContain("project ref");
		expect(out.redactedSourceEntryIds).toEqual(["r1", "r2"]);
	});

	it("leaves non-skill reads and non-read tools untouched", () => {
		const entries = [
			assistantCall("a1", "c1", "read", { path: "/home/u/proj/src/skills.ts" }),
			result("r1", "c1", "read", "export const skills = 1"),
			assistantCall("a2", "c2", "bash", { command: "cat SKILL.md" }),
			result("r2", "c2", "bash", "bash output"),
		];
		const out = serializeSourceAddressedBranchEntries(entries, { redactSkillReads: true, toolCallEntries: entries });
		expect(out.text).toContain("export const skills = 1");
		expect(out.text).toContain("bash output");
		expect(out.redactedSourceEntryIds).toEqual([]);
	});

	it("resolves tool calls that precede the chunk from the supplied branch", () => {
		const branch = [
			assistantCall("a1", "c1", "read", { path: "/x/SKILL.md" }),
			result("r1", "c1", "read", SKILL_TEXT),
		];
		const out = serializeSourceAddressedBranchEntries([branch[1]], { redactSkillReads: true, toolCallEntries: branch });
		expect(out.text).toContain("[skill file /x/SKILL.md loaded; content omitted]");
	});

	it("keeps raw content when the call is unknown", () => {
		const out = serializeSourceAddressedBranchEntries([result("r1", "missing", "read", SKILL_TEXT)], { redactSkillReads: true, toolCallEntries: [] });
		expect(out.text).toContain("lots of instructions");
	});

	it("counts redacted size toward the token budget", () => {
		const big = "x".repeat(40_000);
		const entries = [
			assistantCall("a1", "c1", "read", { path: "/x/SKILL.md" }),
			result("r1", "c1", "read", big),
			result("r2", "c2", "bash", "tail"),
		];
		const raw = serializeSourceAddressedBranchEntries(entries, { maxTokens: 500 });
		const redacted = serializeSourceAddressedBranchEntries(entries, { maxTokens: 500, redactSkillReads: true, toolCallEntries: entries });
		expect(raw.sourceEntryIds).toEqual(["a1"]);
		expect(redacted.sourceEntryIds).toEqual(["a1", "r1", "r2"]);
	});

	it("recall still renders the full original text", () => {
		const entry = result("r1", "c1", "read", SKILL_TEXT);
		expect(renderRecallSourceEntry(entry)).toContain("lots of instructions");
	});
});

describe("observer duplicate tool result collapse", () => {
	it("keeps the first occurrence verbatim and collapses later identical results", () => {
		const entries = [
			result("r1", "c1", "bash", "same output"),
			result("r2", "c2", "bash", "same output"),
			result("r3", "c3", "bash", "different output"),
			result("r4", "c4", "read", "same output"),
		];
		const out = serializeSourceAddressedBranchEntries(entries, { dedupeToolResults: true });
		const [b1, b2, b3, b4] = out.text.split("\n\n");
		expect(b1).toContain("]: same output");
		expect(b2).toContain("]: [identical to source entry r1]");
		expect(b3).toContain("]: different output");
		expect(b4).toContain("]: [identical to source entry r1]");
		expect(out.collapsedSourceEntryIds).toEqual(["r2", "r4"]);
	});

	it("does not dedupe across serialization calls", () => {
		const first = serializeSourceAddressedBranchEntries([result("r1", "c1", "bash", "same output")], { dedupeToolResults: true });
		const second = serializeSourceAddressedBranchEntries([result("r2", "c2", "bash", "same output")], { dedupeToolResults: true });
		expect(first.text).toContain("same output");
		expect(second.text).toContain("same output");
		expect(second.collapsedSourceEntryIds).toEqual([]);
	});

	it("does not dedupe user or assistant text", () => {
		const message = (id: string, role: string) => ({ type: "message", id, message: { role, content: [{ type: "text", text: "hello" }], timestamp: 1_700_000_000_000 } });
		const out = serializeSourceAddressedBranchEntries([message("u1", "user"), message("a1", "assistant"), message("u2", "user")], { dedupeToolResults: true });
		expect(out.collapsedSourceEntryIds).toEqual([]);
	});

	it("both flags off is byte-identical to the unredacted output", () => {
		const entries = [
			assistantCall("a1", "c1", "read", { path: "/x/SKILL.md" }),
			result("r1", "c1", "read", SKILL_TEXT),
			result("r2", "c2", "bash", "same output"),
			result("r3", "c3", "bash", "same output"),
		];
		const baseline = serializeSourceAddressedBranchEntries(entries, { maxTokens: 10_000 });
		const flagsOff = serializeSourceAddressedBranchEntries(entries, {
			maxTokens: 10_000,
			redactSkillReads: false,
			dedupeToolResults: false,
			toolCallEntries: entries,
		});
		expect(flagsOff).toEqual({ ...baseline, redactedSourceEntryIds: [], collapsedSourceEntryIds: [] });
		expect(flagsOff.text).toBe(baseline.text);
	});
});

describe("observer redaction config", () => {
	let root: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-redaction-config-"));
		cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults both flags to true", () => {
		expect(DEFAULTS.observerRedactSkillReads).toBe(true);
		expect(DEFAULTS.observerDedupeToolResults).toBe(true);
		expect(loadConfig(cwd, {}).observerRedactSkillReads).toBe(true);
	});

	it("accepts booleans and ignores invalid values", () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "observational-memory": { observerRedactSkillReads: false, observerDedupeToolResults: "no" } }),
		);
		const config = loadConfig(cwd, {});
		expect(config.observerRedactSkillReads).toBe(false);
		expect(config.observerDedupeToolResults).toBe(true);
	});
});
