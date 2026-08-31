// History → rows for the mobile client (2026-08-31).
// Run: cd web-mobile && npx tsx src/hooks/history.test.mts
//
// Covers the pairing rule that the 2026-08-28 report was about: an
// errored turn has no agent row, so "attach media to the last agent
// row" put the pictures under the PREVIOUS turn's answer. Media now
// pairs by turnId or gets its own row.

import assert from 'node:assert/strict';
import { historyEventsToMessages, type HistoryEvent } from './history';

let ok = 0;
let bad = 0;
const t = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { ok++; console.log('  ok  ', name); }
  else { bad++; console.error('  FAIL', name, detail); }
};

const img = (id: string) => ({ type: 'image', id, filename: `${id}.png`, mime: 'image/png', url: `/media/${id}/file` });

// ── 1. the real 2026-08-28 sequence ─────────────────────────────────
{
  const events: HistoryEvent[] = [
    { kind: 'user_message', ts: 1, text: 'first question' },
    { kind: 'turn_start', ts: 2, turnId: 't-0' },
    { kind: 'assistant_message', ts: 3, text: 'first answer' },
    { kind: 'turn_end', ts: 4, turnId: 't-0' },
    { kind: 'user_message', ts: 10, text: 'make me pictures' },
    { kind: 'turn_start', ts: 11, turnId: 't-1' },
    { kind: 'tool_call', ts: 12 },
    { kind: 'tool_result', ts: 13 },
    { kind: 'error', ts: 14, message: '500 litellm.InternalServerError' },
    { kind: 'turn_end', ts: 15, turnId: 't-1' },
    { kind: 'assistant_media', ts: 16, turnId: 't-1', media: [img('a'), img('b')] },
    { kind: 'user_message', ts: 20, text: 'next question' },
  ];
  const rows = historyEventsToMessages(events);
  const roles = rows.map((r) => r.role).join(',');
  t('row sequence user,agent,user,error,user', roles === 'user,agent,user,error,user', roles);
  const prevAnswer = rows[1]!;
  const errRow = rows[3]!;
  t('previous answer stamped with its turn', prevAnswer.turnId === 't-0', String(prevAnswer.turnId));
  t('previous answer did NOT receive the media', prevAnswer.mediaNote === undefined, JSON.stringify(prevAnswer.mediaNote));
  t('error row carries the message', errRow.text === '500 litellm.InternalServerError', errRow.text);
  t('error row stamped with t-1', errRow.turnId === 't-1', String(errRow.turnId));
  t('media paired to the error row (2 images)', errRow.mediaNote?.images === 2 && errRow.mediaNote.videos === 0, JSON.stringify(errRow.mediaNote));
  t('no extra media-only row was created', rows.length === 5, String(rows.length));
}

// ── 2. healthy turn pairs to its own agent row ──────────────────────
{
  const events: HistoryEvent[] = [
    { kind: 'user_message', ts: 1, text: 'q' },
    { kind: 'turn_start', ts: 2, turnId: 't-9' },
    { kind: 'assistant_message', ts: 3, text: 'here is your picture' },
    { kind: 'turn_end', ts: 4, turnId: 't-9' },
    { kind: 'assistant_media', ts: 5, turnId: 't-9', media: [{ ...img('x'), type: 'video' }] },
  ];
  const rows = historyEventsToMessages(events);
  t('healthy: two rows', rows.length === 2, String(rows.length));
  t('healthy: agent row has the media note (1 video)', rows[1]?.mediaNote?.videos === 1 && rows[1]?.mediaNote?.images === 0, JSON.stringify(rows[1]?.mediaNote));
  t('healthy: agent row keeps its text', rows[1]?.text === 'here is your picture');
}

// ── 3. unknown turnId → media-only agent row ────────────────────────
{
  const events: HistoryEvent[] = [
    { kind: 'user_message', ts: 1, text: 'q' },
    { kind: 'turn_start', ts: 2, turnId: 't-1' },
    { kind: 'assistant_message', ts: 3, text: 'answer' },
    { kind: 'turn_end', ts: 4, turnId: 't-1' },
    { kind: 'assistant_media', ts: 5, turnId: 't-unknown', media: [img('z')] },
  ];
  const rows = historyEventsToMessages(events);
  t('unknown turn: a third row appears', rows.length === 3, String(rows.length));
  t('unknown turn: the answer row is untouched', rows[1]?.mediaNote === undefined);
  const extra = rows[2]!;
  t('unknown turn: media-only agent row', extra.role === 'agent' && extra.text === '' && extra.mediaNote?.images === 1, JSON.stringify(extra));
  t('unknown turn: extra row carries the media turnId', extra.turnId === 't-unknown', String(extra.turnId));
}

// ── 4. audio still folds onto the most recent agent row ─────────────
{
  const events: HistoryEvent[] = [
    { kind: 'turn_start', ts: 1, turnId: 't-1' },
    { kind: 'assistant_message', ts: 2, text: 'spoken' },
    { kind: 'assistant_audio', ts: 3, turnId: 't-1', audio: { url: '/tts/x.mp3', mime: 'audio/mpeg', cacheKey: 'k' } },
    { kind: 'turn_end', ts: 4, turnId: 't-1' },
  ];
  const rows = historyEventsToMessages(events);
  t('audio folded onto the agent row', rows[0]?.audio?.url === '/tts/x.mp3', JSON.stringify(rows[0]));
}

console.log(`\nhistory: ${ok} passed, ${bad} failed`);
assert.equal(bad, 0);
