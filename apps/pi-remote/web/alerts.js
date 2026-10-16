export function needsInputCount(sessions) {
	return sessions.filter((session) => session.state === "input" && !session.incompatible).length;
}

export function titleFor(sessions) {
	const count = needsInputCount(sessions);
	return count > 0 ? `(${count}) needs input` : "pi-remote";
}

function isMain(session) {
	return !session.subagentId && !session.parentSession;
}

export function shouldChime(previous, next) {
	if (!previous) return false;
	const before = new Map(previous.map((session) => [session.pid, session]));
	for (const session of next) {
		if (session.incompatible) continue;
		const old = before.get(session.pid);
		if (session.state === "input" && old?.state !== "input") return true;
		if (old && old.state === "busy" && session.state === "idle" && isMain(session)) return true;
	}
	return false;
}
