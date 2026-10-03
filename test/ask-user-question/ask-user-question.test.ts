import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionToolContext as ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import askUserQuestion from '../../extensions/ask-user-question.ts';

function registeredQuestion() {
  let tool: ToolDefinition<any, any> | undefined;
  askUserQuestion({ registerTool(value) { tool = value; } } as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

test('ask_user_question is model-only and keeps its direct editor interaction and rendering', async () => {
  const tool = registeredQuestion();
  assert.equal(tool.exposure, 'model-only');
  const titles: string[] = [];
  const result = await tool.execute('question', { question: 'Which?', details: 'Context' }, new AbortController().signal, undefined, {
    hasUI: true,
    ui: { editor: async (title: string) => { titles.push(title); return ' Answer '; } },
  } as unknown as ExtensionContext);
  assert.deepEqual(titles, ['Which?\n\nContext']);
  assert.ok(result.content[0].type === 'text');
  assert.equal(result.content[0].text, 'User answered: Answer');
  assert.equal(result.details.status, 'answered');
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  assert.match(tool.renderCall({ question: 'Which?' }, theme as any, {} as any).render(80).join('\n'), /Which\?/);
  assert.match(tool.renderResult(result, { expanded: false, isPartial: false }, theme as any, {} as any).render(80).join('\n'), /Answer/);
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
