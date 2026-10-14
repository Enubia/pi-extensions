import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function setUserVar(name: string, value: string) {
	process.stdout.write(`\x1b]1337;SetUserVar=${name}=${Buffer.from(value).toString("base64")}\x07`);
}

export default function vscodeBridge(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		setUserVar("pi_session_file", ctx.sessionManager.getSessionFile() ?? "");
	});
}
