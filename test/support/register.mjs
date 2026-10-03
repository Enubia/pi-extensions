import { registerHooks } from "node:module";

import { resolveHostModule, resolveHostRoot } from "./host-modules.mjs";

const hostRoot = resolveHostRoot();

registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = resolveHostModule(specifier, hostRoot);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
