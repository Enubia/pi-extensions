export const QUESTION_OPENED_EVENT = "ask-user-question:opened";
export const QUESTION_CLOSED_EVENT = "ask-user-question:closed";
export const QUESTION_ANSWER_EVENT = "ask-user-question:answer";

export type QuestionMode = "text" | "single-select" | "multi-select";

export interface QuestionOption {
	label: string;
	value: string;
	description?: string;
}

export interface QuestionOpened {
	toolCallId: string;
	question: string;
	details?: string;
	mode: QuestionMode;
	options: QuestionOption[];
}

export interface QuestionClosed {
	toolCallId: string;
}

export type RemoteAnswerInput =
	| { type: "option"; index: number }
	| { type: "other"; text: string }
	| { type: "text"; text: string };

export interface QuestionAnswer {
	toolCallId: string;
	answers: RemoteAnswerInput[];
}

export type AskAnswer =
	| { type: "text"; label: string; value: string }
	| { type: "option"; label: string; value: string; index: number }
	| { type: "other"; label: string; value: string };

export function resolveRemoteAnswers(question: QuestionOpened, inputs: readonly RemoteAnswerInput[]): AskAnswer[] | undefined {
	if (question.mode === "text") {
		const [input] = inputs;
		if (inputs.length !== 1 || input.type !== "text") return undefined;
		const text = input.text.trim();
		return [{ type: "text", label: text, value: text }];
	}
	if (inputs.length === 0) return undefined;
	if (question.mode === "single-select" && inputs.length !== 1) return undefined;
	const resolved: AskAnswer[] = [];
	const seen = new Set<number>();
	let others = 0;
	for (const input of inputs) {
		if (input.type === "option") {
			const option = question.options[input.index - 1];
			if (!Number.isInteger(input.index) || !option || seen.has(input.index)) return undefined;
			seen.add(input.index);
			resolved.push({ type: "option", label: option.label, value: option.value, index: input.index });
		} else if (input.type === "other") {
			const text = input.text.trim();
			if (!text || ++others > 1) return undefined;
			resolved.push({ type: "other", label: text, value: text });
		} else {
			return undefined;
		}
	}
	return resolved;
}
