// Regression tests for turn-aware history pairing (2026-08-28 report:
// a failed turn's pictures rendered under the PREVIOUS answer, and the
// error itself was invisible).
//
// Run: npx tsx web/src/lib/history.test.mts   (cwd = repo root)

import assert from 'node:assert/strict';
import { attachMedia, findTurnOwner, historyEventsToMessages } from './history';
import type { HistoryEvent } from './api';
import type { AssistantMedia, ChatMessage } from '../types/chat';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const img = (id: string): AssistantMedia => ({
  type: 'image',
  id,
  prompt: 'p',
  mime: 'image/png',
  filename: `${id}.png`,
  url: `/media/${id}/file`,
});
const ev = (e: Partial<HistoryEvent> & { kind: string }): HistoryEvent => ({ ts: 0, ...e }) as HistoryEvent;

// ── the real 2026-08-28 sequence (spielberg/main, turn t-…469271) ──
{
  const events: HistoryEvent[] = [
    ev({ kind: 'user_message', ts: 1, text: 'first ask' }),
    ev({ kind: 'turn_start', ts: 2, turnId: 't-A' }),
    ev({ kind: 'assistant_message', ts: 3, text: 'first answer' }),
    ev({ kind: 'turn_end', ts: 4, turnId: 't-A' }),
    ev({ kind: 'user_message', ts: 5, text: 'the pictures are not really hi-res' }),
    ev({ kind: 'turn_start', ts: 6, turnId: 't-B' }),
    ev({ kind: 'tool_call', ts: 7, tool: 'image_generate', callId: 'c1', input: {} }),
    ev({ kind: 'tool_result', ts: 8, callId: 'c1', output: { ok: true } }),
    ev({ kind: 'error', ts: 9, message: '500 litellm.InternalServerError: Flash OOM' }),
    ev({ kind: 'turn_end', ts: 10, turnId: 't-B' }),
    ev({ kind: 'assistant_media', ts: 11, turnId: 't-B', media: [img('m1'), img('m2')] as never }),
    ev({ kind: 'user_message', ts: 12, text: 'the empty screen one is good' }),
  ];
  const rows = historyEventsToMessages(events);
  const roles = rows.map((r) => r.role).join(',');
  check(
    'row order: user, assistant, user, tool_call, tool_result, error, user',
    roles === 'user,assistant,user,tool_call,tool_result,error,user',
    roles,
  );
  const firstAnswer = rows[1];
  check('first answer stamped with its turn', firstAnswer?.role === 'assistant' && firstAnswer.turnId === 't-A');
  check('first answer got NO media (the old bug)', firstAnswer?.role === 'assistant' && !firstAnswer.media);
  const err = rows[5];
  check('error row exists with the engine message', err?.role === 'error' && err.text.includes('Flash OOM'));
  check('error row stamped with t-B', err?.role === 'error' && err.turnId === 't-B');
  check('media hangs under the error row', err?.role === 'error' && err.media?.length === 2, JSON.stringify(err));
}

// ── healthy turn pairs media to its own answer ─────────────────────
{
  const events: HistoryEvent[] = [
    ev({ kind: 'user_message', ts: 1, text: 'draw' }),
    ev({ kind: 'turn_start', ts: 2, turnId: 't-1' }),
    ev({ kind: 'assistant_message', ts: 3, text: 'here' }),
    ev({ kind: 'turn_end', ts: 4, turnId: 't-1' }),
    ev({ kind: 'assistant_media', ts: 5, turnId: 't-1', media: [img('x')] as never }),
  ];
  const rows = historyEventsToMessages(events);
  const a = rows[1];
  check('healthy: media on the answer', a?.role === 'assistant' && a.media?.length === 1 && a.turnId === 't-1');
  check('healthy: no extra row', rows.length === 2, String(rows.length));
}

// ── media whose turn left no row → media-only assistant row ────────
{
  const events: HistoryEvent[] = [
    ev({ kind: 'user_message', ts: 1, text: 'a' }),
    ev({ kind: 'turn_start', ts: 2, turnId: 't-1' }),
    ev({ kind: 'assistant_message', ts: 3, text: 'first' }),
    ev({ kind: 'turn_end', ts: 4, turnId: 't-1' }),
    ev({ kind: 'assistant_media', ts: 5, turnId: 't-9', media: [img('y')] as never }),
  ];
  const rows = historyEventsToMessages(events);
  check('unknown turn: previous answer untouched', rows[1]?.role === 'assistant' && !rows[1].media);
  const last = rows[rows.length - 1];
  check(
    'unknown turn: media-only assistant row appended',
    last?.role === 'assistant' && last.text === '' && last.media?.length === 1 && last.turnId === 't-9',
    JSON.stringify(last),
  );
}

// ── legacy files without turnId on media fall back to last answer ──
{
  const rows: ChatMessage[] = [
    { id: '1', role: 'user', ts: 1, text: 'q' },
    { id: '2', role: 'assistant', ts: 2, text: 'a' },
  ];
  check('findTurnOwner(undefined) → last assistant', findTurnOwner(rows, undefined) === 1);
  const next = attachMedia(rows, undefined, [img('z')], 3);
  check('attachMedia(undefined) lands on last assistant', next.length === 2 && next[1]?.role === 'assistant' && next[1].media?.length === 1);
  check('attachMedia does not mutate input', !rows[1] || rows[1].role !== 'assistant' || !rows[1].media);
}

// ── model_fallback still stamps the next answer ────────────────────
{
  const events: HistoryEvent[] = [
    ev({ kind: 'turn_start', ts: 1, turnId: 't-1' }),
    ev({ kind: 'model_fallback', ts: 2, requested: 'a/x', actual: 'b/y', reason: 'boom' } as never),
    ev({ kind: 'assistant_message', ts: 3, text: 'fallback answered' }),
  ];
  const rows = historyEventsToMessages(events);
  check('fallback chip preserved', rows[0]?.role === 'assistant' && rows[0].fallback?.actual === 'b/y');
}

console.log(`history: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
