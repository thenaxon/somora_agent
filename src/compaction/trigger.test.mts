// When does compaction fire?
//
// 2026-09-10, spielberg/main: a session sent 615,329 tokens of tool
// traffic and the trigger saw 25,982 of them, because it counted chat
// text only. It never fired, the session reached 97 %, and the turn died
// at the wall. Two things had to change: count what is actually sent,
// and prefer the number the provider itself reported.
//
// Run: npm test src/compaction/trigger.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateContextSize, inputBudget, shouldCompact } from './policy.ts';
import type { NormalizedEvent } from '../types/events.ts';

const cfg = { triggerRatio: 0.8, safetyCushionPairs: 4 };
const ev = (o: Record<string, unknown>): NormalizedEvent => ({ engine: 'openai-compatible', ...o }) as NormalizedEvent;

/** A turn like spielberg's: a little chat, a lot of tool traffic. */
function agenticHistory(rounds: number): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let ts = 1;
  for (let i = 0; i < rounds; i++) {
    out.push(ev({ kind: 'user_message', ts: ts++, text: 'mach weiter' }));
    out.push(ev({ kind: 'tool_call', ts: ts++, callId: `c${i}`, tool: 'exec', input: { command: 'python3 - <<PY\n' + 'x'.repeat(4_000) + '\nPY' } }));
    out.push(ev({ kind: 'tool_result', ts: ts++, callId: `c${i}`, output: { stdout: 'y'.repeat(20_000) } }));
    out.push(ev({ kind: 'assistant_message', ts: ts++, text: 'fertig' }));
  }
  return out;
}

test('the estimate counts tool traffic, not just chat', () => {
  const history = agenticHistory(20);
  const size = estimateContextSize({ systemPrompt: 'sys', history });
  const chatOnly = history
    .filter((e) => e.kind === 'user_message' || e.kind === 'assistant_message')
    .reduce((n, e) => n + ((e as { text: string }).text.length ?? 0), 0);
  assert.ok(size > 15_000, `tool arguments dominate an agentic session: ${size}`);
  assert.ok(size > chatOnly / 4 * 10, 'and they are an order of magnitude above the chat text');
});

test('a tool result counts as much as the replay actually sends', () => {
  // The replay caps each result at 800 characters; the estimate must not
  // charge for what never travels.
  const huge = [ev({ kind: 'tool_result', ts: 1, callId: 'c', output: { stdout: 'z'.repeat(500_000) } })];
  const size = estimateContextSize({ systemPrompt: '', history: huge });
  assert.ok(size < 400, `capped like the replay: ${size}`);
});

test('the budget is the window minus the answer, not the window', () => {
  // The 2026-09-10 numbers: the request that died had 507,905 input
  // tokens — one over the input budget, far under the window.
  assert.equal(inputBudget(524_288, 16_384), 507_904);
  assert.equal(inputBudget(524_288, undefined), 524_288, 'no declared cap: assume none');
  assert.equal(inputBudget(1_000, 4_000), 1_000, 'a nonsense cap falls back to the window');

  const decision = shouldCompact({
    systemPrompt: '',
    history: [],
    contextWindow: 524_288,
    maxOutputTokens: 16_384,
    config: cfg,
    measuredTokens: 420_000,
  });
  assert.equal(decision.triggerTokens, Math.floor(0.8 * 507_904));
  assert.equal(decision.shouldCompact, true, '420k is past 80 % of the input budget');
});

test('the provider\'s own count beats the estimate', () => {
  const history = agenticHistory(2);
  const withoutMeasure = shouldCompact({ systemPrompt: '', history, contextWindow: 200_000, config: cfg });
  assert.equal(withoutMeasure.source, 'estimated');
  assert.equal(withoutMeasure.shouldCompact, false);

  const withMeasure = shouldCompact({
    systemPrompt: '',
    history,
    contextWindow: 200_000,
    config: cfg,
    measuredTokens: 190_000,
  });
  assert.equal(withMeasure.source, 'measured');
  assert.equal(withMeasure.shouldCompact, true, 'the reading knows what the estimate cannot');
  assert.equal(withMeasure.estimatedTokens, 190_000);
});

test('a stale reading below the estimate does not hide new growth', () => {
  // The reading covers the last request; everything appended since only
  // exists in the estimate. The larger of the two decides.
  const history = agenticHistory(30);
  const est = estimateContextSize({ systemPrompt: '', history });
  const d = shouldCompact({ systemPrompt: '', history, contextWindow: 200_000, config: cfg, measuredTokens: 10 });
  assert.equal(d.source, 'estimated');
  assert.equal(d.estimatedTokens, est);
});

test('the reported incident: this session would now compact', () => {
  // Measured on the real session: 615,329 tokens of tool traffic, of
  // which the old trigger saw 25,982.
  const d = shouldCompact({
    systemPrompt: 'sys',
    history: [],
    contextWindow: 524_288,
    maxOutputTokens: 16_384,
    config: cfg,
    measuredTokens: 507_905,
  });
  assert.equal(d.shouldCompact, true);
  assert.ok(d.ratio > 1, 'it was already past the whole input budget');
});
