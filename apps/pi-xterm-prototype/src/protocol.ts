export type WebviewSettings = {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	macOptionIsMeta: boolean;
	renderer: "webgl" | "dom";
};

export type FromWebview =
	| { type: "ready"; cols: number; rows: number }
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "title"; title: string }
	| { type: "progress"; state: number }
	| { type: "notify"; title?: string; body: string }
	| { type: "clipboard"; text: string }
	| { type: "openUrl"; url: string }
	| { type: "openFile"; path: string; line?: number; column?: number };

export type ToWebview =
	| { type: "output"; data: string }
	| { type: "exit"; code: number }
	| { type: "focus" };
