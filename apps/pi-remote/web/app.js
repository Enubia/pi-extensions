import { needsInputCount, shouldChime, titleFor } from "./alerts.js";
import { appendDelta, applySnapshot, mergeOlder, upsertEntry } from "./entries.js";
import { answersFor, composerFor, selectionIsValid } from "./input.js";
import { renderMarkdown } from "./markdown.js";
import { formatAge, orderSessions } from "./sessions.js";

const ENTRY_CAP = 300;
const $ = (id) => document.getElementById(id);

const hashToken = /[#&]t=([^&]+)/.exec(location.hash)?.[1];
if (hashToken) {
	sessionStorage.setItem("pi-remote-token", decodeURIComponent(hashToken));
	history.replaceState(null, "", location.pathname + location.search);
}
const token = sessionStorage.getItem("pi-remote-token") ?? "";

const state = {
	sessions: null,
	openPid: null,
	entries: [],
	hasMore: false,
	clientId: null,
	source: null,
	failures: 0,
	retry: null,
	dismissed: new Set(),
	selected: new Set(),
	audio: null,
};
const elements = new Map();

async function api(path, body) {
	const response = await fetch(path, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw Object.assign(new Error(payload.message ?? `HTTP ${response.status}`), { code: payload.error, status: response.status });
	return payload;
}

function toast(message) {
	const node = $("toast");
	node.textContent = message;
	node.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (node.hidden = true), 3500);
}

function currentSession() {
	return state.sessions?.find((session) => session.pid === state.openPid);
}

function activeQuestion(session) {
	const question = session?.question;
	return question && !state.dismissed.has(question.toolCallId) ? question : undefined;
}

function viewOf(session) {
	return session && { ...session, question: activeQuestion(session) };
}

function setConnection(text) {
	$("conn").textContent = text;
	const banner = $("banner");
	banner.hidden = !text;
	banner.textContent = text;
}

function connect() {
	clearTimeout(state.retry);
	state.source?.close();
	state.clientId = null;
	if (!token) {
		setConnection("Missing token — rescan the QR code");
		return;
	}
	const source = new EventSource(`/events?t=${encodeURIComponent(token)}`);
	state.source = source;
	source.addEventListener("ready", (event) => {
		state.failures = 0;
		state.clientId = JSON.parse(event.data).clientId;
		setConnection("");
		subscribe();
		if (state.openPid !== null) loadSnapshot();
	});
	source.addEventListener("sessions", (event) => onSessions(JSON.parse(event.data).sessions));
	source.addEventListener("entry", (event) => {
		const data = JSON.parse(event.data);
		if (data.pid !== state.openPid) return;
		state.entries = upsertEntry(state.entries, data.entry, ENTRY_CAP);
		syncTranscript();
	});
	source.addEventListener("text_delta", (event) => {
		const data = JSON.parse(event.data);
		if (data.pid !== state.openPid) return;
		state.entries = appendDelta(state.entries, data.id, data.delta);
		syncTranscript();
	});
	source.onerror = () => {
		if (state.source !== source) return;
		source.close();
		state.clientId = null;
		state.failures += 1;
		setConnection(state.failures > 4 ? "Disconnected — rescan the QR code if this persists" : "Reconnecting…");
		state.retry = setTimeout(connect, Math.min(10000, 500 * 2 ** state.failures));
	};
}

function subscribe() {
	if (!state.clientId) return;
	api("/api/subscribe", { clientId: state.clientId, pids: state.openPid === null ? [] : [state.openPid] }).catch((error) => {
		if (error.status === 404) connect();
	});
}

function onSessions(sessions) {
	if (shouldChime(state.sessions, sessions)) chime();
	state.sessions = sessions;
	const open = new Set(sessions.map((session) => session.question?.toolCallId).filter(Boolean));
	for (const id of state.dismissed) if (!open.has(id)) state.dismissed.delete(id);
	document.title = titleFor(sessions);
	if (state.openPid !== null && !currentSession()) {
		toast("Session ended");
		closeSession();
		return;
	}
	renderList();
	renderSession();
}

function renderList() {
	const rows = orderSessions(state.sessions ?? []);
	const list = $("sessions");
	list.replaceChildren(
		...rows.map(({ session, depth }) => {
			const item = document.createElement("li");
			const button = document.createElement("button");
			button.className = `session${session.incompatible ? " incompatible" : ""}`;
			button.style.marginLeft = `${depth * 20}px`;
			button.style.width = `calc(100% - ${depth * 20}px)`;
			const label = document.createElement("span");
			label.className = "label";
			const name = document.createElement("b");
			name.textContent = session.label;
			const sub = document.createElement("small");
			sub.textContent = session.incompatible ? "incompatible, /reload" : session.cwd ?? "";
			label.append(name, sub);
			const badge = document.createElement("span");
			badge.className = `badge ${session.state}`;
			badge.textContent = session.incompatible ? "incompatible" : session.state === "input" ? "needs input" : session.state;
			const age = document.createElement("span");
			age.className = "age";
			age.textContent = formatAge(session.lastActivity);
			button.append(label, badge, age);
			button.addEventListener("click", () => openSession(session.pid));
			item.append(button);
			return item;
		}),
	);
	$("empty").hidden = rows.length > 0;
}

function openSession(pid) {
	state.openPid = pid;
	state.entries = [];
	state.hasMore = false;
	state.selected.clear();
	elements.clear();
	$("entries").replaceChildren();
	$("list-view").hidden = true;
	$("session-view").hidden = false;
	subscribe();
	renderSession();
	loadSnapshot();
}

function closeSession() {
	state.openPid = null;
	state.entries = [];
	elements.clear();
	$("session-view").hidden = true;
	$("list-view").hidden = false;
	subscribe();
	renderList();
}

async function loadSnapshot(before) {
	const pid = state.openPid;
	if (pid === null) return;
	try {
		const result = await api(`/api/sessions/${pid}/snapshot`, before ? { before } : {});
		if (pid !== state.openPid) return;
		const stick = nearBottom();
		state.entries = before ? mergeOlder(state.entries, result.entries) : applySnapshot(state.entries, result.entries, ENTRY_CAP);
		state.hasMore = result.hasMore;
		syncTranscript(before ? "keep" : stick ? "bottom" : "keep");
	} catch (error) {
		handleError(error);
	}
}

function nearBottom() {
	const box = $("transcript");
	return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function renderEntry(entry) {
	const key = JSON.stringify([entry.text, entry.status, entry.durationMs, entry.summary]);
	let node = elements.get(entry.id);
	if (node?.dataset.key === key) return node;
	const expanded = node?.classList.contains("open");
	node = node ?? document.createElement("div");
	node.dataset.key = key;
	node.className = `entry ${entry.kind}${expanded ? " open" : ""}`;
	if (entry.kind === "assistant") {
		node.innerHTML = renderMarkdown(entry.text ?? "");
	} else if (entry.kind === "user") {
		node.textContent = entry.text ?? "";
	} else {
		const line = document.createElement("div");
		line.className = "line";
		const summary = document.createElement("span");
		summary.textContent = entry.summary ?? entry.name;
		const status = document.createElement("span");
		status.className = `status ${entry.status}`;
		status.textContent = entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "…";
		line.append(summary, status);
		if (typeof entry.durationMs === "number") {
			const duration = document.createElement("span");
			duration.textContent = `${(entry.durationMs / 1000).toFixed(1)}s`;
			line.append(duration);
		}
		const args = document.createElement("pre");
		args.textContent = typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args, null, 2);
		args.hidden = !expanded;
		node.replaceChildren(line, args);
		node.onclick = () => {
			node.classList.toggle("open");
			args.hidden = !node.classList.contains("open");
		};
	}
	elements.set(entry.id, node);
	return node;
}

function syncTranscript(scroll) {
	const stick = scroll === "bottom" || (scroll !== "keep" && nearBottom());
	const box = $("transcript");
	const previousHeight = box.scrollHeight;
	const live = new Set(state.entries.map((entry) => entry.id));
	for (const id of [...elements.keys()]) if (!live.has(id)) elements.delete(id);
	$("entries").replaceChildren(...state.entries.map(renderEntry));
	$("more").hidden = !state.hasMore;
	if (stick) box.scrollTop = box.scrollHeight;
	else if (scroll === "keep") box.scrollTop += box.scrollHeight - previousHeight;
}

function renderSession() {
	const session = viewOf(currentSession());
	if (!session) return;
	$("session-title").textContent = session.label;
	const badge = $("session-state");
	badge.className = `badge ${session.state}`;
	badge.textContent = session.state === "input" ? "needs input" : session.state;
	const composer = composerFor(session);
	$("text").disabled = composer.disabled;
	$("text").placeholder = composer.placeholder;
	$("send").textContent = composer.label;
	$("send").disabled = composer.disabled;
	$("queue").hidden = !composer.canQueue;
	$("queue").disabled = composer.disabled;
	$("composer").hidden = composer.disabled;
	$("notice").hidden = !composer.notice;
	$("notice").textContent = composer.notice ?? "";
	renderQuestion(session.question);
}

let renderedQuestion = null;
function renderQuestion(question) {
	const panel = $("question");
	panel.hidden = !question;
	if (!question) {
		renderedQuestion = null;
		return;
	}
	if (renderedQuestion === question.toolCallId) return;
	renderedQuestion = question.toolCallId;
	state.selected.clear();
	$("question-text").textContent = question.question;
	$("question-details").textContent = question.details ?? "";
	const multi = question.mode === "multi-select";
	$("question-submit").hidden = !multi;
	$("question-options").replaceChildren(
		...(question.mode === "text" ? [] : question.options).map((option, index) => {
			const body = document.createElement("span");
			const title = document.createElement("span");
			title.textContent = option.label;
			body.append(title);
			if (option.description) {
				const description = document.createElement("small");
				description.textContent = option.description;
				body.append(description);
			}
			if (multi) {
				const label = document.createElement("label");
				const box = document.createElement("input");
				box.type = "checkbox";
				box.addEventListener("change", () => (box.checked ? state.selected.add(index) : state.selected.delete(index)));
				label.append(box, body);
				return label;
			}
			const button = document.createElement("button");
			button.type = "button";
			button.append(body);
			button.addEventListener("click", () => submitAnswer({ indexes: [index] }));
			return button;
		}),
	);
}

async function submitAnswer(selection) {
	const session = viewOf(currentSession());
	const question = session?.question;
	if (!question) return;
	if (!selectionIsValid(question, selection)) {
		toast("Pick an option or type an answer");
		return;
	}
	try {
		await api(`/api/sessions/${session.pid}/answer`, { toolCallId: question.toolCallId, answers: answersFor(question, selection) });
		$("text").value = "";
		autosize();
	} catch (error) {
		handleError(error, question);
	}
}

async function submitText(mode) {
	const session = viewOf(currentSession());
	const text = $("text").value.trim();
	if (!session || !text) return;
	if (session.question) {
		await submitAnswer({ text, indexes: [...state.selected] });
		return;
	}
	try {
		await api(`/api/sessions/${session.pid}/send`, { text, mode });
		$("text").value = "";
		autosize();
	} catch (error) {
		handleError(error);
	}
}

function handleError(error, question) {
	if (error.code === "stale") {
		if (question) state.dismissed.add(question.toolCallId);
		renderSession();
		return;
	}
	if (error.code === "unknown_session") {
		toast("Session ended");
		closeSession();
		return;
	}
	if (error.code === "incompatible") toast("Session incompatible, /reload it");
	else if (error.status === 401) toast("Unauthorized — rescan the QR code");
	else toast(error.message || "Request failed");
}

function autosize() {
	const box = $("text");
	box.style.height = "auto";
	box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
}

function unlockAudio() {
	if (!state.audio) {
		const Context = window.AudioContext ?? window.webkitAudioContext;
		if (!Context) return;
		state.audio = new Context();
	}
	if (state.audio.state !== "running") state.audio.resume().catch(() => {});
}

function chime() {
	const context = state.audio;
	if (!context || context.state !== "running") return;
	const now = context.currentTime;
	[880, 1175].forEach((frequency, index) => {
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		oscillator.frequency.value = frequency;
		gain.gain.setValueAtTime(0.0001, now + index * 0.18);
		gain.gain.exponentialRampToValueAtTime(0.25, now + index * 0.18 + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.18 + 0.3);
		oscillator.connect(gain).connect(context.destination);
		oscillator.start(now + index * 0.18);
		oscillator.stop(now + index * 0.18 + 0.32);
	});
}

document.addEventListener("pointerdown", unlockAudio, { passive: true });
$("back").addEventListener("click", closeSession);
$("more").addEventListener("click", () => state.entries[0] && loadSnapshot(state.entries[0].id));
$("composer").addEventListener("submit", (event) => {
	event.preventDefault();
	submitText("auto");
});
$("queue").addEventListener("click", () => submitText("followUp"));
$("question-submit").addEventListener("click", () => submitAnswer({ indexes: [...state.selected], text: $("text").value }));
$("text").addEventListener("input", autosize);
$("abort").addEventListener("click", async () => {
	const session = currentSession();
	if (!session || !confirm(`Abort ${session.label}?`)) return;
	try {
		await api(`/api/sessions/${session.pid}/abort`);
	} catch (error) {
		handleError(error);
	}
});
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible") return;
	unlockAudio();
	state.failures = 0;
	connect();
});
setInterval(() => {
	if (state.sessions && state.openPid === null) renderList();
}, 15000);

connect();
