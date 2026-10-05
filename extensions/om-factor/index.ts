import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function omFactor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("om-factor is deprecated: enable observational-memory for /om:factor and remove the standalone om-factor installation. No commands are registered by this shim.", "warning");
	});
}
