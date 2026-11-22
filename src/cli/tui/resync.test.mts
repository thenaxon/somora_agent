// What the TUI replays after a (re)connect (2026-11-22, Codex review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsMidTurn, lastUserTs, missedEvents } from './resync.ts';
import type { HistoryEvent } from './api.ts';

const u = (ts: number, text = `u${ts}`): HistoryEvent => ({ kind: 'user_message', ts, text });
const a = (ts: number, text = `a${ts}`): HistoryEvent => ({ kind: 'assistant_message', ts, text });
const tc = (ts: number): HistoryEvent => ({ kind: 'tool_call', ts, tool: 'exec', callId: `c${ts}` });
const te = (ts: number): HistoryEvent => ({ kind: 'turn_end', ts });

test('nothing new: nothing to replay', () => {
  const h = [u(1), a(2), te(3)];
  assert.deepEqual(missedEvents(h, 1, false).events, []);
});

test('the running turn finished while away: its reply, not its tools', () => {
  const h = [u(1), tc(2), tc(3), a(4), te(5)];
  const m = missedEvents(h, 1, true);
  assert.deepEqual(m.events.map((e) => e.kind), ['assistant_message']);
  assert.equal(m.turnEnded, true);
  assert.equal(m.skippedTools, 2);
});

test('the running turn is still running: nothing yet', () => {
  const h = [u(1), tc(2)];
  const m = missedEvents(h, 1, true);
  assert.deepEqual(m.events, []);
  assert.equal(m.turnEnded, false);
});

test('whole turns that started while away come back whole', () => {
  const h = [u(1), a(2), te(3), u(10), tc(11), a(12), te(13)];
  const m = missedEvents(h, 1, false);
  assert.deepEqual(m.events.map((e) => e.kind), ['user_message', 'tool_call', 'assistant_message', 'turn_end']);
});

test('the anchor is found even when newer turns exist', () => {
  const h = [u(1), a(2), te(3), u(5), a(6), te(7), u(9), a(10), te(11)];
  assert.deepEqual(missedEvents(h, 5, false).events.map((e) => e.ts), [9, 10, 11]);
});

test('an anchor missing from the history replays nothing', () => {
  assert.deepEqual(missedEvents([u(5), a(6)], 3, false).events, []);
});

test('the history tells whether it ends inside a turn', () => {
  assert.equal(endsMidTurn([u(1), tc(2)]), true);
  assert.equal(endsMidTurn([u(1), a(2), te(3)]), false);
  assert.equal(endsMidTurn([]), false);
  assert.equal(lastUserTs([u(1), a(2), u(7), a(8)]), 7);
  assert.equal(lastUserTs([a(2)]), null);
});
