const STATE_RANK = { input: 0, busy: 1, "tui-dialog": 1, idle: 2 };

function rankOf(session) {
	if (session.incompatible) return 3;
	return STATE_RANK[session.state] ?? 2;
}

function compare(a, b) {
	return rankOf(a) - rankOf(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
}

export function orderSessions(sessions) {
	const bySessionId = new Map();
	for (const session of sessions) if (session.sessionId) bySessionId.set(session.sessionId, session);
	const parentOf = (session) => {
		const parent = session.parentSession ? bySessionId.get(session.parentSession) : undefined;
		return parent && parent !== session ? parent : undefined;
	};
	const children = new Map();
	const roots = [];
	for (const session of sessions) {
		const parent = parentOf(session);
		if (!parent) {
			roots.push(session);
			continue;
		}
		const siblings = children.get(parent) ?? [];
		siblings.push(session);
		children.set(parent, siblings);
	}

	const seen = new Set();
	const groupRank = new Map();
	const rankGroup = (session, trail) => {
		if (groupRank.has(session)) return groupRank.get(session);
		if (trail.has(session)) return rankOf(session);
		trail.add(session);
		let best = rankOf(session);
		for (const child of children.get(session) ?? []) best = Math.min(best, rankGroup(child, trail));
		trail.delete(session);
		groupRank.set(session, best);
		return best;
	};
	const groupCompare = (a, b) => rankGroup(a, new Set()) - rankGroup(b, new Set()) || compare(a, b);

	const rows = [];
	const visit = (session, depth) => {
		if (seen.has(session)) return;
		seen.add(session);
		rows.push({ session, depth });
		for (const child of [...(children.get(session) ?? [])].sort(groupCompare)) visit(child, depth + 1);
	};
	for (const root of [...roots].sort(groupCompare)) visit(root, 0);
	for (const session of sessions) visit(session, 0);
	return rows;
}

export function formatAge(timestamp, now = Date.now()) {
	if (typeof timestamp !== "number") return "";
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
