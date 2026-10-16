import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionToolContext as ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import askUserQuestion from '../../extensions/ask-user-question.ts';
import { QUESTION_ANSWER_EVENT, QUESTION_CLOSED_EVENT, QUESTION_OPENED_EVENT } from '../../extensions/question-events.ts';

function createBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(name: string, handler: (data: unknown) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => { handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler)); };
    },
    emit(name: string, data: unknown) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
    },
    count: (name: string) => (handlers.get(name) ?? []).length,
  };
}

function registeredQuestion(bus = createBus()) {
  let tool: ToolDefinition<any, any> | undefined;
  askUserQuestion({ events: bus, registerTool(value: ToolDefinition<any, any>) { tool = value; } } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };

function createDialogContext() {
  const dialog: { component?: any; closed: boolean; opened: number } = { closed: false, opened: 0 };
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: any) =>
        new Promise((resolve) => {
          dialog.opened++;
          dialog.component = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, {}, (value: unknown) => {
            dialog.closed = true;
            resolve(value);
          });
        }),
    },
  } as unknown as ExtensionContext;
  return { ctx, dialog };
}

function recordEvents(bus: ReturnType<typeof createBus>) {
  const log: Array<{ name: string; data: any }> = [];
  for (const name of [QUESTION_OPENED_EVENT, QUESTION_CLOSED_EVENT]) bus.on(name, (data) => log.push({ name, data }));
  return log;
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('ask_user_question is model-only, takes text answers in a multi-line dialog and renders', async () => {
  const tool = registeredQuestion();
  assert.equal(tool.exposure, 'model-only');
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('question', { question: 'Which?', details: 'Context' }, new AbortController().signal, undefined, ctx);
  await tick();
  const screen = dialog.component.render(80).join('\n');
  assert.match(screen, /Which\?/);
  assert.match(screen, /Context/);
  for (const key of ['A', 'n', 's']) dialog.component.handleInput(key);
  dialog.component.handleInput('\x1b[13;2u');
  dialog.component.handleInput('x');
  dialog.component.handleInput('\r');
  const result = await pending;
  assert.ok(result.content[0].type === 'text');
  assert.equal(result.content[0].text, 'User answered: Ans\nx');
  assert.equal(result.details.status, 'answered');
  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  assert.match(tool.renderCall({ question: 'Which?' }, theme as any, {} as any).render(80).join('\n'), /Which\?/);
  assert.match(tool.renderResult(result, { expanded: false, isPartial: false }, theme as any, {} as any).render(80).join('\n'), /Ans/);
});

test('ask_user_question still handles unavailable UI and pre-aborted calls', async () => {
  const tool = registeredQuestion();
  const controller = new AbortController();
  const ctx = { hasUI: false } as ExtensionContext;
  const unavailable = await tool.execute('unavailable', { question: 'Which?' }, controller.signal, undefined, ctx);
  assert.equal(unavailable.details.status, 'unavailable');
  controller.abort();
  const cancelled = await tool.execute('cancelled', { question: 'Which?' }, controller.signal, undefined, ctx);
  assert.equal(cancelled.details.status, 'cancelled');
});

test('escape in the text dialog cancels', async () => {
  const tool = registeredQuestion();
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('q', { question: 'Which?' }, new AbortController().signal, undefined, ctx);
  await tick();
  dialog.component.handleInput('\x1b');
  assert.equal((await pending).details.status, 'cancelled');
});

test('opening a question publishes it on pi.events and closing publishes the id', async () => {
  const bus = createBus();
  const log = recordEvents(bus);
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('call-1', { question: 'Pick', details: ' why ', options: [{ label: 'A', description: 'first' }, { label: 'B', value: 'b' }], multiSelect: true }, new AbortController().signal, undefined, ctx);
  await tick();
  assert.deepEqual(log, [{ name: QUESTION_OPENED_EVENT, data: { toolCallId: 'call-1', question: 'Pick', details: 'why', mode: 'multi-select', options: [{ label: 'A', value: 'A', description: 'first' }, { label: 'B', value: 'b' }] } }]);
  dialog.component.handleInput(' ');
  dialog.component.handleInput('\x1b[B');
  dialog.component.handleInput('\x1b[B');
  dialog.component.handleInput('\x1b[B');
  dialog.component.handleInput('\r');
  await pending;
  assert.deepEqual(log[1], { name: QUESTION_CLOSED_EVENT, data: { toolCallId: 'call-1' } });
  assert.equal(log.length, 2);
  assert.equal(bus.count(QUESTION_ANSWER_EVENT), 0);
});

test('TUI answer emits question_closed once in text mode', async () => {
  const bus = createBus();
  const log = recordEvents(bus);
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('call-t', { question: 'Why?' }, new AbortController().signal, undefined, ctx);
  await tick();
  dialog.component.handleInput('o');
  dialog.component.handleInput('\r');
  await pending;
  assert.deepEqual(log.map((entry) => entry.name), [QUESTION_OPENED_EVENT, QUESTION_CLOSED_EVENT]);
});

test('remote answer resolves text mode and closes the TUI dialog', async () => {
  const bus = createBus();
  const log = recordEvents(bus);
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('call-r', { question: 'Why?' }, new AbortController().signal, undefined, ctx);
  await tick();
  bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 'call-r', answers: [{ type: 'text', text: ' phone ' }] });
  const result = await pending;
  assert.equal(dialog.closed, true);
  assert.equal(result.details.status, 'answered');
  assert.deepEqual(result.details.answers, [{ type: 'text', label: 'phone', value: 'phone' }]);
  assert.deepEqual(result.content, [{ type: 'text', text: 'User answered: phone' }]);
  assert.deepEqual(log.map((entry) => entry.name), [QUESTION_OPENED_EVENT, QUESTION_CLOSED_EVENT]);
});

test('remote answer resolves single-select with option and other', async () => {
  for (const [input, expected] of [
    [{ type: 'option', index: 2 }, { type: 'option', label: 'B', value: 'b', index: 2 }],
    [{ type: 'other', text: ' mine ' }, { type: 'other', label: 'mine', value: 'mine' }],
  ] as const) {
    const bus = createBus();
    const tool = registeredQuestion(bus);
    const { ctx, dialog } = createDialogContext();
    const pending = tool.execute('s', { question: 'Pick', options: [{ label: 'A' }, { label: 'B', value: 'b' }] }, new AbortController().signal, undefined, ctx);
    await tick();
    bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 's', answers: [input] });
    const result = await pending;
    assert.equal(dialog.closed, true);
    assert.deepEqual(result.details.answers, [expected]);
    assert.equal(result.details.mode, 'single-select');
  }
});

test('remote answer resolves multi-select sorted like the TUI', async () => {
  const bus = createBus();
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('m', { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }, new AbortController().signal, undefined, ctx);
  await tick();
  bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 'm', answers: [{ type: 'other', text: 'z' }, { type: 'option', index: 2 }, { type: 'option', index: 1 }] });
  const result = await pending;
  assert.equal(dialog.closed, true);
  assert.deepEqual(result.details.answers.map((answer: any) => answer.label), ['A', 'B', 'z']);
  assert.deepEqual(result.content, [{ type: 'text', text: 'User selected:\n- 1. A\n- 2. B\n- Other: z' }]);
});

test('answers for another tool call or invalid for the mode are ignored', async () => {
  const bus = createBus();
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('x', { question: 'Pick', options: [{ label: 'A' }] }, new AbortController().signal, undefined, ctx);
  await tick();
  bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 'other', answers: [{ type: 'option', index: 1 }] });
  bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 'x', answers: [{ type: 'option', index: 9 }] });
  assert.equal(dialog.closed, false);
  bus.emit(QUESTION_ANSWER_EVENT, { toolCallId: 'x', answers: [{ type: 'option', index: 1 }] });
  assert.equal((await pending).details.status, 'answered');
});

test('aborting the tool closes the dialog, clears the question and cancels', async () => {
  const bus = createBus();
  const log = recordEvents(bus);
  const tool = registeredQuestion(bus);
  const { ctx, dialog } = createDialogContext();
  const controller = new AbortController();
  const pending = tool.execute('ab', { question: 'Pick', options: [{ label: 'A' }] }, controller.signal, undefined, ctx);
  await tick();
  controller.abort();
  const result = await pending;
  assert.equal(result.details.status, 'cancelled');
  assert.equal(dialog.closed, true);
  assert.deepEqual(log.map((entry) => entry.name), [QUESTION_OPENED_EVENT, QUESTION_CLOSED_EVENT]);
  assert.equal(bus.count(QUESTION_ANSWER_EVENT), 0);
});

test('works without a remote extension listening', async () => {
  const tool = registeredQuestion();
  const { ctx, dialog } = createDialogContext();
  const pending = tool.execute('n', { question: 'Pick', options: [{ label: 'A' }] }, new AbortController().signal, undefined, ctx);
  await tick();
  dialog.component.handleInput('\r');
  assert.equal((await pending).details.answers[0].label, 'A');
});
