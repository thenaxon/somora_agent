// Tool activity rows on the phone (hooks/activity.ts, history.ts).
// Run: cd web-mobile && npx tsx src/hooks/activity.test.mts
//
// The case behind it (2026-10-29): a builder worked for two hours with
// 168 tool calls and no text; the phone, opened in between, showed an
// empty chat. Its turn now has one activity row — from history when the
// phone joins late, extended live, closed at the end.

import assert from 'node:assert/strict';
import {
  applyLiveTool,
  closeLiveActivities,
  historyEventsToMessages,
  mergeHistorySnapshot,
  prependOlderMessages,
  type ChatMessage,
  type HistoryEvent,
} from './history';
import { formatDuration, MAX_STEPS, stepLabel } from './activity';
import { defaultShowTools } from './useToolSwitch';

let ok = 0;
let bad = 0;
const t = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { ok++; console.log('  ok  ', name); }
  else { bad++; console.error('  FAIL', name, detail); }
};
const roles = (rows: ChatMessage[]) => rows.map((r) => r.role).join(',');

// The shape a session file really has (a builder's turn, 2026-10-29).
const call = (ts: number, id: string, tool: string, input: unknown): HistoryEvent => ({ kind: 'tool_call', ts, callId: id, tool, input });
const result = (ts: number, id: string, error?: string): HistoryEvent => ({ kind: 'tool_result', ts, callId: id, ...(error ? { error } : {}) });

{
  const events: HistoryEvent[] = [
    { kind: 'user_message', ts: 1, text: 'Fix the tool ceiling tests' },
    { kind: 'turn_start', ts: 2, turnId: 't-1' },
    { kind: 'engine_meta', ts: 3, itemType: 'context_compacted', payload: { text: 'history compacted' } },
    call(10, 'c1', 'file_read', { path: '/repo/models.py' }),
    result(11, 'c1'),
    call(20, 'c2', 'exec', { command: 'cd backend && pytest tests/test_tool_ceiling.py' }),
    result(30, 'c2'),
    call(40, 'c3', 'file_patch', { path: '/repo/tests/test_tool_ceiling.py', edits: [] }),
    result(41, 'c3', 'no match'),
    call(50, 'c4', 'exec', { command: 'pytest' }),
  ];
  const rows = historyEventsToMessages(events);
  t('running turn: user, note, activity', roles(rows) === 'user,note,activity', roles(rows));
  const a = rows[2]!.activity!;
  t('running turn: four calls', a.total === 4 && a.steps.length === 4);
  t('running turn: open', a.endedAt === undefined);
  t('running turn: turnId stamped', rows[2]!.turnId === 't-1');
  t('labels: path and command', a.steps[0]!.label === '/repo/models.py' && a.steps[1]!.label.startsWith('cd backend && pytest'));
  t('states: done, done, error, running', a.steps.map((s) => s.state).join(',') === 'done,done,error,running', a.steps.map((s) => s.state).join(','));
  t('error text kept', a.steps[2]!.error === 'no match');

  // The turn goes on live: same row, then it ends.
  let live = applyLiveTool(rows, { phase: 'result', tool: 'exec', callId: 'c4', details: '{}' }, 60, 't-1');
  t('live result settles the history call', live[2]!.activity!.steps[3]!.state === 'done');
  live = applyLiveTool(live, { phase: 'call', tool: 'mcp__somora__todo_write', callId: 'c5', details: JSON.stringify({ todos: [1, 2, 3] }) }, 70, 't-1');
  t('live call joins the open row', live.length === 3 && live[2]!.activity!.total === 5, roles(live));
  t('live call: short name and label', live[2]!.activity!.steps[4]!.tool === 'todo_write' && live[2]!.activity!.steps[4]!.label === '3 tasks');
  live = [...live, { id: 'a1', role: 'agent', text: 'Report …', ts: 80 }];
  live = closeLiveActivities(live, 90);
  t('end closes the row, nothing runs', live[2]!.activity!.endedAt === 90 && live[2]!.activity!.steps.every((s) => s.state !== 'running'));
  t('close is a no-op when nothing is open', closeLiveActivities(live, 95) === live);
}

{
  // Ended turns from history, and a chat turn without tools.
  const events: HistoryEvent[] = [
    { kind: 'user_message', ts: 1, text: 'weather?' },
    { kind: 'turn_start', ts: 2, turnId: 't-1' },
    call(3, 'c1', 'web_search', { query: 'weather vienna' }),
    result(4, 'c1'),
    { kind: 'assistant_message', ts: 5, text: 'Sunny.' },
    { kind: 'turn_end', ts: 6, turnId: 't-1' },
    { kind: 'user_message', ts: 7, text: 'thanks' },
    { kind: 'turn_start', ts: 8, turnId: 't-2' },
    { kind: 'assistant_message', ts: 9, text: 'Welcome.' },
    { kind: 'turn_end', ts: 10, turnId: 't-2' },
  ];
  const rows = historyEventsToMessages(events);
  t('ended: activity above its reply, none for a turn without tools', roles(rows) === 'user,activity,agent,user,agent', roles(rows));
  t('ended: closed at turn_end', rows[1]!.activity!.endedAt === 6);
  t('ended: time counts from the turn start', rows[1]!.activity!.startedAt === 2);
  t('ended: query label', rows[1]!.activity!.steps[0]!.label === 'weather vienna');
  // A new turn starts live: its first call opens a new row, not the old one.
  const live = applyLiveTool(
    [...rows, { id: 'u3', role: 'user', text: 'again', ts: 11 }],
    { phase: 'call', tool: 'web_search', callId: 'x', details: '{"query":"q"}' },
    12,
    't-3',
  );
  t('new turn: new row at the end', roles(live) === 'user,activity,agent,user,agent,user,activity' && live[6]!.activity!.total === 1, roles(live));
}

{
  // Live placement: above the streaming reply and above waiting messages.
  const prev: ChatMessage[] = [
    { id: 'u1', role: 'user', text: 'go', ts: 1 },
    { id: 'a1', role: 'agent', text: 'Let me look', ts: 2, streaming: true },
    { id: 'u2', role: 'user', text: 'queued', ts: 3, pending: true },
  ];
  const next = applyLiveTool(prev, { phase: 'call', tool: 'file_read', details: '{"path":"/a"}' }, 4, null);
  t('placed above the streaming bubble', roles(next) === 'user,activity,agent,user', roles(next));
  const r = applyLiveTool(next, { phase: 'result', tool: 'file_read', details: '{}' }, 5, null);
  t('result without callId pairs by tool', r[1]!.activity!.steps[0]!.state === 'done');
  const orphan = applyLiveTool(prev, { phase: 'result', tool: 'file_read' }, 5, null);
  t('a result with no open row changes nothing', orphan === prev);
}

{
  // Joining late: the snapshot is the newest page, in the middle of a
  // turn. Live rows already persisted are not shown twice.
  const restored = historyEventsToMessages([call(100, 'c9', 'exec', { command: 'ls' }), result(101, 'c9'), call(200, 'c10', 'exec', { command: 'pwd' })]);
  const liveRows: ChatMessage[] = [
    { id: 'n', role: 'note', text: 'compacted', ts: 150 },
    { id: 'a', role: 'agent', text: 'new text', ts: 300 },
  ];
  const merged = mergeHistorySnapshot(restored, liveRows);
  t('merge: activity covers to its last call', roles(merged) === 'activity,agent', roles(merged));
  t('merge: page cut mid-turn has no turnId and stays open', merged[0]!.turnId === undefined && merged[0]!.activity!.endedAt === undefined);

  // Scrolling up loads the start of the same turn: one row.
  const older = historyEventsToMessages([
    { kind: 'user_message', ts: 1, text: 'build' },
    { kind: 'turn_start', ts: 2, turnId: 't-9' },
    call(10, 'c1', 'file_read', { path: '/x' }),
    result(11, 'c1'),
  ]);
  const joined = prependOlderMessages(older, restored);
  t('prepend: one activity row for the cut turn', roles(joined) === 'user,activity', roles(joined));
  t('prepend: counts add up, turnId kept', joined[1]!.activity!.total === 3 && joined[1]!.turnId === 't-9');
}

{
  // A night of calls: the newest MAX_STEPS stay, the count goes on.
  const events: HistoryEvent[] = [{ kind: 'turn_start', ts: 0, turnId: 't' }];
  for (let i = 1; i <= MAX_STEPS + 50; i += 1) events.push(call(i, `c${i}`, 'exec', { command: `step ${i}` }), result(i, `c${i}`));
  const a = historyEventsToMessages(events)[0]!.activity!;
  t('cap: steps kept', a.steps.length === MAX_STEPS);
  t('cap: count of all', a.total === MAX_STEPS + 50);
  t('cap: newest kept', a.steps[a.steps.length - 1]!.label === `step ${MAX_STEPS + 50}`);
}

{
  t('label: unknown input is empty', stepLabel('time_now', {}) === '');
  t('label: long command cut', stepLabel('exec', { command: 'x'.repeat(300) }).length <= 121);
  t('label: pretty JSON from the live event', stepLabel('exec', '{\n  "command": "npm test"\n}') === 'npm test');
  t('duration', formatDuration(45_000) === '45 s' && formatDuration(12 * 60_000) === '12 min' && formatDuration(128 * 60_000) === '2:08 h');
  t('switch default: builder on, chat as config', defaultShowTools('builder', false) && !defaultShowTools('chat', false) && defaultShowTools('chat', true));
}

console.log(`\nactivity: ${ok} passed, ${bad} failed`);
assert.equal(bad, 0);
