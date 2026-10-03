export function costFromAgentEvent(event: unknown): number | undefined {
	if (!event || typeof event !== "object") return undefined;
	const typed = event as { type?: string; message?: { role?: string; usage?: { cost?: { total?: unknown } } } };
	if (typed.type !== "message_end") return undefined;
	const message = typed.message;
	if (message?.role !== "assistant") return undefined;
	const total = message.usage?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : undefined;
}

export function reportCost(event: unknown, onCost: ((usd: number) => void) | undefined): void {
	if (!onCost) return;
	const usd = costFromAgentEvent(event);
	if (usd !== undefined) onCost(usd);
}
