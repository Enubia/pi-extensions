import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import { Type } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { reflectionToSummaryLine, type Reflection } from "../../session-ledger/index.js";
import { estimateStringTokens, reflectionLineTokenCount } from "../../tokens.js";
import { WorkerStreamError, logAgentStreamError, streamFailureFromEvent } from "../stream-errors.js";
import { reportCost } from "../usage-cost.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { normalizeReflectionContent } from "../reflector/agent.js";
import { reflectionTokenSum } from "./pool.js";
import { MERGER_SYSTEM } from "./prompts.js";

interface RunMergerArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reflections: Reflection[];
	observationIds: readonly string[];
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
	onCost?: (usd: number) => void;
}

const MergeReflectionsSchema = Type.Object({
	merged: Type.Array(
		Type.Object({
			content: Type.String(),
			supersedesReflectionIds: Type.Array(Type.String()),
		}),
		{ minItems: 1 },
	),
});

type MergeReflectionsArgs = Static<typeof MergeReflectionsSchema>;

export function mergedReflectionId(content: string, supersedesReflectionIds: readonly string[]): string {
	return hashId([content, ...[...supersedesReflectionIds].sort()].join("\n"));
}

export async function runMerger(args: RunMergerArgs): Promise<Reflection[] | undefined> {
	const { model, apiKey, headers, env, reflections, signal } = args;
	if (reflections.length < 2) return undefined;

	const poolTokens = reflectionTokenSum(reflections);
	const activeById = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const observationOrder = Array.from(new Set(args.observationIds));
	const knownReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const consumed = new Set<string>();
	const accumulated = new Map<string, Reflection>();
	let projectedTokens = poolTokens;
	let toolCallCount = 0;
	let rawProposedCount = 0;
	let rejectedCount = 0;
	let duplicateCount = 0;
	let targetReachedCount = 0;

	debugLog("merger.agent_start", { reflectionCount: reflections.length, poolTokens, targetTokens: args.targetTokens });

	const mergeReflections: AgentTool<typeof MergeReflectionsSchema> = {
		name: "merge_reflections",
		label: "Merge reflections",
		description: "Replace overlapping or redundant active reflections with merged reflections.",
		parameters: MergeReflectionsSchema,
		execute: async (_id, params: MergeReflectionsArgs) => {
			toolCallCount++;
			rawProposedCount += params.merged.length;
			let added = 0;
			let rejected = 0;
			let duplicates = 0;
			let targetReached = 0;
			for (const proposal of params.merged) {
				if (projectedTokens <= args.targetTokens) {
					targetReached++;
					continue;
				}
				const content = normalizeReflectionContent(proposal.content);
				const supersedes = Array.from(new Set(proposal.supersedesReflectionIds));
				const valid = !!content
					&& supersedes.length > 0
					&& supersedes.every((id) => activeById.has(id) && !consumed.has(id));
				if (!valid || !content) {
					rejected++;
					continue;
				}
				const supported = new Set(supersedes.flatMap((id) => activeById.get(id)?.supportingObservationIds ?? []));
				const supporting = observationOrder.filter((observationId) => supported.has(observationId));
				if (supporting.length === 0) {
					rejected++;
					continue;
				}
				const id = mergedReflectionId(content, supersedes);
				if (knownReflectionIds.has(id) || accumulated.has(id)) {
					duplicates++;
					continue;
				}
				const merged: Reflection = {
					id,
					content,
					supportingObservationIds: supporting,
					tokenCount: estimateStringTokens(content),
					supersedesReflectionIds: [...supersedes].sort(),
				};
				accumulated.set(id, merged);
				for (const supersededId of supersedes) {
					consumed.add(supersededId);
					const superseded = activeById.get(supersededId);
					if (superseded) projectedTokens -= reflectionLineTokenCount(superseded);
				}
				projectedTokens += reflectionLineTokenCount(merged);
				added++;
			}
			rejectedCount += rejected;
			duplicateCount += duplicates;
			targetReachedCount += targetReached;
			const note = targetReached > 0 ? ` ${targetReached} not applied: pool is projected at or below target; stop merging.` : "";
			return {
				content: [{ type: "text", text: `Merged ${added} item${added === 1 ? "" : "s"}; ${rejected} rejected; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}. Projected pool ~${projectedTokens} / target ${args.targetTokens} tokens.${note}` }],
				details: { added, rejected, duplicates, targetReached, projectedTokens },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:\n${reflections.map(reflectionToSummaryLine).join("\n")}\n\nPOOL: ~${poolTokens} estimated tokens. TARGET: ~${args.targetTokens} estimated tokens.\n\nMerge overlapping or redundant reflections to bring the pool toward the target. If nothing can be merged without losing meaning, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { messages: [{ role: "system", content: MERGER_SYSTEM, timestamp: Date.now() }], tools: [mergeReflections as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? {
			finishTurn: ({ message }) => {
				if (message.stopReason === "error" || message.stopReason === "aborted") return;
				return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
			},
		} : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	let streamFailure: ReturnType<typeof streamFailureFromEvent>;
	for await (const event of stream) {
		logAgentStreamError("merger", event);
		reportCost(event, args.onCost);
		streamFailure = streamFailureFromEvent(event) ?? streamFailure;
	}
	await stream.result();
	if (accumulated.size === 0 && streamFailure) throw new WorkerStreamError("merger", streamFailure.stopReason, streamFailure.errorMessage);
	const accepted = Array.from(accumulated.values());
	debugLog("merger.result", {
		reason: accepted.length > 0 ? "accepted_nonempty" : toolCallCount === 0 ? "no_tool_call" : "all_filtered",
		toolCallCount,
		rawProposedCount,
		acceptedCount: accepted.length,
		rejectedCount,
		duplicateCount,
		targetReachedCount,
		projectedTokens,
		supersededCount: consumed.size,
	});
	return accepted.length > 0 ? accepted : undefined;
}
