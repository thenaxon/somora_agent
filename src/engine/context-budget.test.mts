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
  calibratedEstimate,
  estimateRequestTokens,
  parseProviderLimits,
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

// ── what a refusal tells us (2026-09-10) ────────────────────────────

test('a provider refusal is read for the numbers it states', () => {
  const litellm =
    "400 litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: OpenAIException - " +
    "This model's maximum context length is 524288 tokens. However, you requested 16384 output tokens and your prompt " +
    'contains at least 507905 input tokens, for a total of at least 524289 tokens.';
  assert.deepEqual(parseProviderLimits(litellm), {
    contextWindow: 524_288,
    promptTokens: 507_905,
    outputTokens: 16_384,
  });

  const promptTooLong = '400 litellm.BadRequestError: OpenAIException - Prompt too long: 251709 tokens exceeds max context window of 131072 tokens';
  assert.deepEqual(parseProviderLimits(promptTooLong), { contextWindow: 131_072, promptTokens: 251_709 });

  // A refusal that names nothing must not invent anything.
  assert.deepEqual(parseProviderLimits('400 oMLX prefill memory guard rejected this prompt'), {});
});

test('one measured reading corrects the next estimate', () => {
  // The 2026-09-10 turn: we said 327,051, the backend counted 507,905.
  const ratio = 507_905 / 327_051;
  assert.ok(ratio > 1.5, 'code-heavy content is denser than the heuristic assumes');
  assert.equal(calibratedEstimate(327_051, ratio), 507_905);
  // Clamped both ways, so one odd reading cannot run away with the budget.
  assert.equal(calibratedEstimate(1_000, 12), 3_000);
  assert.equal(calibratedEstimate(1_000, 0.01), 500);
  assert.equal(calibratedEstimate(1_000, undefined), 1_000);
});

test('the trimmer works in the same currency as the decision', () => {
  // Live on 2026-09-10: the check said 23,345 against a budget of 20,800
  // and asked for a trim; the trimmer counted raw characters, saw 19,610
  // and reported "fits" — so nothing was shortened and the two disagreed.
  const messages: BudgetMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(20_000) });
  }
  const raw = estimateRequestTokens(messages);
  const ratio = 1.2;
  const budget = Math.floor(raw * 1.1); // raw fits, calibrated does not

  const uncalibrated = trimToolResults(messages, { budget });
  assert.equal(uncalibrated.trimmed, 0, 'in raw currency there is nothing to do');

  const calibrated = trimToolResults(messages, { budget, ratio });
  assert.ok(calibrated.trimmed > 0, 'with the correction it actually shortens');
  assert.ok(calibrated.fits, 'and reaches the budget');
  assert.ok(calibrated.estimate >= raw * 0.5, 'the reported estimate is in the caller\'s currency');
});
