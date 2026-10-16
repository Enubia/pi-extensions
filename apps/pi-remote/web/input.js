export function composerFor(session) {
	if (session.incompatible) return { kind: "none", label: "Send", canQueue: false, placeholder: "", disabled: true, notice: "incompatible, /reload" };
	if (session.state === "tui-dialog") return { kind: "none", label: "Send", canQueue: false, placeholder: "", disabled: true, notice: "waiting on a TUI dialog" };
	if (session.question) {
		const text = session.question.mode === "text";
		return { kind: "answer", label: text ? "Answer" : "Other", canQueue: false, placeholder: text ? "Your answer" : "Other…", disabled: false };
	}
	if (session.state === "idle") return { kind: "send", label: "Send", canQueue: true, placeholder: "Message", disabled: false };
	return { kind: "send", label: "Steer", canQueue: true, placeholder: "Steer", disabled: false };
}

export function answersFor(question, selection) {
	const text = (selection.text ?? "").trim();
	if (question.mode === "text") return [{ type: "text", text }];
	const answers = (selection.indexes ?? []).map((index) => ({ type: "option", index }));
	if (text) answers.push({ type: "other", text });
	return answers;
}

export function selectionIsValid(question, selection) {
	return answersFor(question, selection).length > 0 && !(question.mode === "text" && !(selection.text ?? "").trim());
}
