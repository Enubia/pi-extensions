import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startCompaction, type TriggerCtx } from "../hooks/compaction-trigger.js";
import { launchConsolidation, type ConsolidationCtx } from "../hooks/consolidation-trigger.js";
import type { Runtime } from "../runtime.js";
import { OM_ENABLED, type EnabledEntryData } from "../session-ledger/index.js";

export function registerControlCommands(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om, /om on, /om off)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				ctx.ui.notify(`Observational memory already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			const data: EnabledEntryData = { enabled: next };
			pi.appendEntry(OM_ENABLED, data);
			ctx.ui.notify(`Observational memory ${next ? "enabled" : "disabled"} for this session`, "info");
		},
	});

	pi.registerCommand("om:compact", {
		description: "Force an observational-memory compaction now (ignores the threshold)",
		handler: async (_args, ctx) => {
			if (!runtime.enabled) {
				ctx.ui.notify("Observational memory is off for this session (/om on)", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Observational memory: agent is busy; wait for the turn to finish before forcing a compaction", "warning");
				return;
			}
			if (runtime.compactInFlight) {
				ctx.ui.notify("Observational memory: a compaction is already in progress", "warning");
				return;
			}
			startCompaction(pi, runtime, ctx as unknown as TriggerCtx, { shouldResume: false });
		},
	});

	pi.registerCommand("om:consolidate", {
		description: "Force an observational-memory consolidation run now (observer → reflector → dropper)",
		handler: async (_args, ctx) => {
			if (!runtime.enabled) {
				ctx.ui.notify("Observational memory is off for this session (/om on)", "warning");
				return;
			}
			if (runtime.consolidationInFlight) {
				ctx.ui.notify("Observational memory: a consolidation is already running", "warning");
				return;
			}
			const launched = launchConsolidation(pi, runtime, ctx as unknown as ConsolidationCtx, { force: true });
			ctx.ui.notify(
				launched ? "Observational memory: consolidation started" : "Observational memory: consolidation could not start",
				launched ? "info" : "warning",
			);
		},
	});
}
