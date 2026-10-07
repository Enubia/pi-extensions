import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerControlCommands } from "./commands/control.js";
import { registerFactorCommand } from "./commands/factor.js";
import { registerModelCommand } from "./commands/model.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCacheAwareCompaction } from "./hooks/cache-aware-compaction.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { readEnabledFromLedger, Runtime } from "./runtime.js";
import type { Entry } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	pi.on("session_start", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.enabled = readEnabledFromLedger(ctx.sessionManager.getBranch() as Entry[]);
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
		runtime.cacheColdReason = undefined;
		runtime.cacheLastWarmAt = undefined;
		runtime.lastColdSignal = undefined;
	});

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCacheAwareCompaction(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerControlCommands(pi, runtime);
	registerModelCommand(pi, runtime);
	registerFactorCommand(pi);
	registerRecallTool(pi);
}
