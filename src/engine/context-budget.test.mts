// Sizing one request, and making room without breaking the conversation.
//
// 2026-09-10: a turn was estimated at 58,583 tokens, ran eighteen tool
// calls, and reached the backend at over 507,905 against a 524,288
// window. The old estimate counted user and assistant text only, so
// tool results, images and the tool schemas were invisible.
//
// Run: npm test src/engine/context-budget.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRequestTokens,
  promptBudget,
  trimToolResults,
  type BudgetMessage,
} from './context-budget.ts';

const toolResult = (id: string, chars: number): BudgetMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: 'x'.repeat(chars),
});
const assistantCall = (id: string): BudgetMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'file_read', arguments: '{"path":"a"}' } }],
});

test('the estimate counts what the old one ignored', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'look at these' },
    assistantCall('c1'),
    toolResult('c1', 40_000),
  ];
  const withoutTools = estimateRequestTokens(messages);
  assert.ok(withoutTools > 10_000, `tool results count: ${withoutTools}`);

  const tools = [{ type: 'function', function: { name: 'x', description: 'y'.repeat(20_000), parameters: {} } }];
  const withTools = estimateRequestTokens(messages, tools);
  assert.ok(withTools - withoutTools > 4_000, 'the tool schemas travel with every request');
});

test('an image costs what an image costs, not what its base64 is long', () => {
  const base64 = 'A'.repeat(4_000_000); // ~4 MB data URL
  const withImage = estimateRequestTokens([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] },
  ]);
  assert.ok(withImage < 2_000, `one image must not read as a full window: ${withImage}`);
  assert.ok(withImage > 1_000, 'but it is not free either');
});

test('the budget leaves room for the answer and for being wrong', () => {
  assert.equal(promptBudget({ contextWindow: 100_000, maxOutputTokens: 10_000 }), 85_000);
  const noDeclaredCap = promptBudget({ contextWindow: 100_000 });
  assert.ok(noDeclaredCap < 96_000 && noDeclaredCap > 88_000, `default reserve applies: ${noDeclaredCap}`);
});

test('trimming shortens the oldest results and keeps every pair intact', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do a lot' },
  ];
  for (let i = 1; i <= 8; i++) {
    messages.push(assistantCall(`c${i}`));
    messages.push(toolResult(`c${i}`, 40_000));
  }
  const before = estimateRequestTokens(messages);
  const budget = Math.floor(before / 2);
  const trim = trimToolResults(messages, { budget, keepRecent: 4 });

  assert.ok(trim.fits, `did not reach the budget: ${trim.estimate} > ${budget}`);
  assert.ok(trim.trimmed > 0, 'something was shortened');
  assert.equal(trim.messages.length, messages.length, 'no message is ever dropped');

  // Every tool_call still has its answer, in order — this is what a
  // backend rejects when a naive fix drops messages.
  const callIds = trim.messages.filter((m) => m.tool_calls).map((m) => (m.tool_calls as any)[0].id);
  const replyIds = trim.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(replyIds, callIds);

  // Oldest first, and the newest result is never touched: that is the
  // one the model is about to reason about, and shortening it is how you
  // get the same tool called a second time.
  const tools = trim.messages.filter((m) => m.role === 'tool');
  const isShort = (m: BudgetMessage) => typeof m.content === 'string' && m.content.startsWith('[somora:');
  assert.equal(isShort(tools.at(-1)!), false, 'the newest result stays whole');
  const shortened = tools.filter(isShort);
  assert.equal(shortened.length, trim.trimmed);
  assert.deepEqual(
    tools.map(isShort),
    tools.map((_, i) => i < trim.trimmed),
    'it eats from the front',
  );
  assert.match(shortened[0]!.content as string, /do not run it again/);
  // The original is untouched — the caller decides whether to adopt the copy.
  assert.equal((messages[3]!.content as string).length, 40_000);
});

test('a turn with nothing left to shorten says so instead of pretending', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: 'x'.repeat(400_000) },
    { role: 'user', content: 'hello' },
  ];
  const trim = trimToolResults(messages, { budget: 1_000 });
  assert.equal(trim.trimmed, 0);
  assert.equal(trim.fits, false);
});

test('when the old results are not enough it reaches into the recent ones, never the last', () => {
  const messages: BudgetMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let i = 1; i <= 6; i++) {
    messages.push(assistantCall(`c${i}`));
    messages.push(toolResult(`c${i}`, 40_000));
  }
  // keepRecent 4 leaves only two old ones; the budget needs five gone.
  const trim = trimToolResults(messages, { budget: 12_000, keepRecent: 4 });
  assert.equal(trim.trimmed, 5);
  const tools = trim.messages.filter((m) => m.role === 'tool');
  assert.equal((tools.at(-1)!.content as string).length, 40_000);
});
