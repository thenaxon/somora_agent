// A call must not disconnect the people watching the session (2026-09-12).
//
// Run: npx tsx src/server/sse-session-event.test.mts
//
// What happened: realtime voice writes into a session outside any turn —
// the caller's spoken line, the line the voice self said back, the note
// that a call changed hands. Those went to `publish()` as raw internal
// events through a cast. The SSE writer stringifies `event.data`, got
// undefined, and threw; `publish()` reads a throwing subscriber as a
// dead one and tears its stream down. So every spoken line kicked the
// chat window, the TUI and the phone off that session: 85 evictions in
// one evening, all of them `TypeError: Cannot read properties of
// undefined`.
//
// The frames themselves are proven against hono's real writer in
// private/smokes/voice-sse-frames-smoke.mts. This test guards the
// contract that made the frames writable in the first place: every
// event this path can carry comes out with an event name and a payload.
import assert from 'node:assert/strict';

import { serializeSessionEvent } from './sse-serializer.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

const spoken = {
  kind: 'user_message',
  ts: 1_700_000_000_000,
  engine: 'voice',
  text: 'mach mir das tetris nochmal auf',
  input: { modality: 'voice', source: 'realtime' },
} as NormalizedEvent;

const saidBack = {
  kind: 'engine_meta',
  ts: 1_700_000_000_001,
  engine: 'voice',
  itemType: 'voice_spoken',
  payload: { text: 'mach ich, einen moment' },
} as NormalizedEvent;

const handover = {
  kind: 'engine_meta',
  ts: 1_700_000_000_002,
  engine: 'voice',
  itemType: 'voice_handover',
  payload: { text: '[voice] handed this call over to lisa (session "main")' },
} as NormalizedEvent;

// ── every event this path carries must be writable ───────────────────
// Writable means both fields exist. An undefined `data` is what threw.
for (const [name, ev] of [
  ['the spoken line', spoken],
  ['what the voice said back', saidBack],
  ['the handover note', handover],
] as const) {
  const sse = serializeSessionEvent(ev);
  check(`${name}: serializes`, sse !== null);
  if (!sse) continue;
  check(`${name}: has an event name`, typeof sse.event === 'string' && sse.event.length > 0, String(sse?.event));
  check(`${name}: has a payload`, sse.data !== undefined && sse.data !== null);
  check(`${name}: the payload survives JSON`, (() => {
    const s = JSON.stringify(sse.data);
    return typeof s === 'string' && s.length > 0;
  })());
}

// ── the spoken line keeps what makes it spoken ───────────────────────
// The live bubble and the one rebuilt from history read the same two
// fields. Drop them here and a sentence said in a call renders as a
// typed one until the page is reloaded.
{
  const sse = serializeSessionEvent(spoken)!;
  const d = sse.data as { text?: string; input?: { modality?: string; source?: string } };
  check('spoken line: is a user_message', sse.event === 'user_message', String(sse.event));
  check('spoken line: keeps its text', d.text === 'mach mir das tetris nochmal auf');
  check('spoken line: stays marked as voice', d.input?.modality === 'voice', JSON.stringify(d.input));
  check('spoken line: stays marked as a call', d.input?.source === 'realtime', JSON.stringify(d.input));
}

// A typed turn has no `input` block and must not grow one.
{
  const typed = { kind: 'user_message', ts: 1, engine: 'x', text: 'hallo' } as NormalizedEvent;
  const d = serializeSessionEvent(typed)!.data as { input?: unknown };
  check('a typed line carries no input block', d.input === undefined, JSON.stringify(d.input));
}

// ── tool events have no turn out here ────────────────────────────────
// Their correlation lives in a per-turn serializer. Dropped beats
// half-correct: a tool_result without its call renders as "?" forever.
{
  const call = { kind: 'tool_call', ts: 1, engine: 'voice', callId: 'c1', tool: 'x', input: {} } as unknown as NormalizedEvent;
  const result = { kind: 'tool_result', ts: 2, engine: 'voice', callId: 'c1', output: {} } as unknown as NormalizedEvent;
  check('a tool call on this path is dropped', serializeSessionEvent(call) === null);
  check('a tool result on this path is dropped', serializeSessionEvent(result) === null);
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
