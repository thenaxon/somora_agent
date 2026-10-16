// The ACP ⇄ somora translation against what OpenClaw and Hermes really
// sent (recorded 2026-10-16 over ssh, src/acp/__fixtures__), and the way
// back for `somora acp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTurnTranslator, SomoraToAcp, SseToAcp, historyToAcp, toolName } from './translate.ts';
import { initialsBadge, profileByName, profileFor, profileFromCommand } from './profiles.ts';
import type { NormalizedEvent } from '../types/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
type Rec = { t: number; kind: string; data: any };
function recording(name: string): Rec[] {
  return readFileSync(join(here, '__fixtures__', `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}
/** The updates and the result of one probe step. */
function stepOf(recs: Rec[], step: string): { updates: SessionUpdate[]; result: any } {
  const updates: SessionUpdate[] = [];
  let inside = false;
  let result: any = null;
  for (const r of recs) {
    if (r.kind === 'step') inside = r.data === step;
    else if (inside && r.kind === 'update') updates.push(r.data.update);
    else if (r.kind === 'result' && r.data.step === step) result = r.data.r;
  }
  return { updates, result };
}
function run(updates: SessionUpdate[], result: any): { events: NormalizedEvent[]; tr: AcpTurnTranslator } {
  const tr = new AcpTurnTranslator('t1', 'acp', () => 1);
  const events: NormalizedEvent[] = [];
  for (const u of updates) events.push(...tr.update(u));
  const usage = result?.usage
    ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, thoughtTokens: result.usage.thoughtTokens }
    : undefined;
  events.push(...tr.finish(result?.stopReason ?? 'end_turn', usage));
  return { events, tr };
}
const ofKind = <K extends NormalizedEvent['kind']>(evs: NormalizedEvent[], k: K) => evs.filter((e) => e.kind === k) as Extract<NormalizedEvent, { kind: K }>[];

test('OpenClaw: a shell call shows as tool call and result, the reply as one message', () => {
  const { updates, result } = stepOf(recording('openclaw'), 'prompt1');
  const { events } = run(updates, result);
  const [call] = ofKind(events, 'tool_call');
  assert.equal(call!.tool, 'exec');
  assert.match(String((call!.input as { command?: string }).command), /ls ~ \| wc -l/);
  const [res] = ofKind(events, 'tool_result');
  assert.equal(res!.callId, call!.callId);
  assert.match(String(res!.output), /^0\n\d\d:\d\d/);
  assert.equal(res!.error, undefined);
  const [msg] = ofKind(events, 'assistant_message');
  assert.match(msg!.text, /Einträge/);
  assert.equal(ofKind(events, 'thinking_message').length, 0, 'OpenClaw sent no thinking');
  const end = ofKind(events, 'turn_end')[0]!;
  assert.equal(end.usage, undefined, 'OpenClaw reports no usage');
  // Order the chat relies on: the call before its result before the reply.
  const idx = (k: string) => events.findIndex((e) => e.kind === k);
  assert.ok(idx('tool_call') < idx('tool_result') && idx('tool_result') < idx('assistant_message') && idx('assistant_message') < idx('turn_end'));
});

test('Hermes: thinking and reply stream word by word, leading blank lines dropped, usage fills the header', () => {
  const { updates, result } = stepOf(recording('hermes'), 'prompt1');
  const { events } = run(updates, result);
  const deltas = ofKind(events, 'assistant_delta');
  assert.ok(deltas.length > 5, 'many deltas');
  assert.ok(deltas.every((d, i) => i === 0 || d.text.startsWith(deltas[i - 1]!.text)), 'deltas are cumulative');
  const [msg] = ofKind(events, 'assistant_message');
  assert.equal(msg!.text, msg!.text.trimStart(), 'no leading blank lines');
  assert.match(msg!.text, /Einträge/);
  assert.ok(ofKind(events, 'thinking_message')[0]!.text.length > 20);
  const [call] = ofKind(events, 'tool_call');
  assert.equal(call!.tool, 'terminal');
  const end = ofKind(events, 'turn_end')[0]!;
  assert.equal(end.usage?.context_window, 524288);
  assert.ok((end.usage?.context_tokens ?? 0) > 1000);
  assert.ok((end.usage?.tokens_in ?? 0) > 1000);
});

test('Hermes cancel: the turn ends as stopped, a late piece after the stop is dropped', () => {
  const recs = recording('hermes-cancel');
  const { updates, result } = stepOf(recs, 'prompt3-cancelled');
  const tr = new AcpTurnTranslator('t', 'acp', () => 1);
  // Everything up to the response, then the stop, then what came after.
  const after = recs.filter((r) => r.kind === 'update' && r.t > recs.find((x) => x.kind === 'result' && x.data.step === 'prompt3-cancelled')!.t).map((r) => r.data.update);
  const before = updates.filter((u) => !after.includes(u));
  for (const u of before) tr.update(u);
  const end = tr.finish(result.stopReason);
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(end.some((e) => e.kind === 'turn_end'));
  for (const u of after) assert.deepEqual(tr.update(u), []);
  assert.equal(tr.lateUpdates, after.length);
  assert.ok(after.length >= 1, 'the recording has the late piece');
});

test('a tool still open when the turn stops is closed as stopped', () => {
  const tr = new AcpTurnTranslator('t', 'acp', () => 1);
  tr.update({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'exec: sleep 99', kind: 'execute', status: 'in_progress' });
  const evs = tr.finish('cancelled');
  const res = evs.find((e) => e.kind === 'tool_result') as { error?: string };
  assert.equal(res.error, 'stopped');
});

test('an update for an unseen tool call starts it; a failed tool carries the error', () => {
  const tr = new AcpTurnTranslator('t', 'acp', () => 1);
  const evs = tr.update({ sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'read: a.txt', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }] });
  assert.equal(evs[0]!.kind, 'tool_call');
  assert.equal((evs[1] as { error?: string }).error, 'no such file');
});

test('a stop without text says why', () => {
  const tr = new AcpTurnTranslator('t', 'acp', () => 1);
  const evs = tr.finish('max_tokens');
  assert.match((evs.find((e) => e.kind === 'assistant_message') as { text: string }).text, /output limit/);
  assert.deepEqual((evs.find((e) => e.kind === 'turn_end') as { degraded?: unknown }).degraded, { reason: 'max_tokens' });
});

test('tool names: ACP name, else the title head, else the kind', () => {
  assert.equal(toolName('exec: command: ls', 'shell', 'execute'), 'shell');
  assert.equal(toolName('terminal: ls ~ + 1 command', undefined, 'execute'), 'terminal');
  assert.equal(toolName('A very long title without any colon in it at all, really long', undefined, 'read'), 'read');
});

test('somora → ACP: cumulative deltas become pieces, tools become tool calls, usage the fill', () => {
  const s = new SomoraToAcp();
  const e = (x: Partial<NormalizedEvent> & { kind: string }) => ({ ts: 1, engine: 'x', ...x }) as NormalizedEvent;
  const out = [
    ...s.update(e({ kind: 'thinking_delta', text: 'Let me' })),
    ...s.update(e({ kind: 'thinking_delta', text: 'Let me look' })),
    ...s.update(e({ kind: 'tool_call', callId: 'c1', tool: 'exec', input: { command: 'date' } })),
    ...s.update(e({ kind: 'tool_result', callId: 'c1', output: { stdout: '14:00' } })),
    ...s.update(e({ kind: 'assistant_delta', text: 'It is' })),
    ...s.update(e({ kind: 'assistant_delta', text: 'It is 14:00.' })),
    ...s.update(e({ kind: 'assistant_message', text: 'It is 14:00.' })),
    ...s.update(e({ kind: 'turn_end', turnId: 't', usage: { tokens_in: 1, tokens_out: 1, context_tokens: 900, context_window: 8000 } })),
  ];
  const kinds = out.map((u) => u.sessionUpdate);
  assert.deepEqual(kinds, ['agent_thought_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_message_chunk', 'usage_update']);
  const texts = out.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => (u as any).content.text);
  assert.deepEqual(texts, ['It is', ' 14:00.'], 'the final message adds nothing already sent');
  assert.equal((out[2] as any).title, 'exec: date');
  assert.equal((out[2] as any).kind, 'execute');
  assert.equal((out[3] as any).status, 'completed');
});

test('history → ACP replay: user, tools and replies in order, deltas skipped', () => {
  const e = (x: any) => ({ ts: 1, engine: 'x', ...x }) as NormalizedEvent;
  const out = historyToAcp([
    e({ kind: 'user_message', text: 'hi' }),
    e({ kind: 'assistant_delta', text: 'hel' }),
    e({ kind: 'tool_call', callId: 'a', tool: 'time_now', input: {} }),
    e({ kind: 'tool_result', callId: 'a', output: '12:00' }),
    e({ kind: 'assistant_message', text: 'hello' }),
    e({ kind: 'turn_end', turnId: 't' }),
    e({ kind: 'user_message', text: 'again' }),
    e({ kind: 'assistant_message', text: 'sure' }),
  ]);
  assert.deepEqual(out.map((u) => u.sessionUpdate), ['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'user_message_chunk', 'agent_message_chunk']);
  assert.equal((out[5] as any).content.text, 'sure', 'each turn starts its text afresh');
});

test('profiles: picked from the self-introduction, with their sign; OpenClaw hides schedule sessions', () => {
  assert.equal(profileFor({ name: 'openclaw-acp', title: 'OpenClaw ACP Gateway' }).badge, '🦞');
  assert.equal(profileFor({ name: 'hermes-agent' }).badge, '☤');
  const g = profileFor({ name: 'goose', title: 'Goose' });
  assert.equal(g.name, 'generic');
  assert.equal(g.badge, undefined);
  assert.equal(g.label, 'Goose');
  const hide = profileByName('openclaw').hideSession!;
  assert.equal(hide({ sessionId: 'agent:main:cron:123', _meta: { sessionKey: 'agent:main:cron:123' } }), true);
  assert.equal(hide({ sessionId: 'agent:main:somora-1' }), false);
  assert.equal(initialsBadge('OpenClaw ACP Gateway'), 'OA');
  assert.equal(initialsBadge('goose'), 'GO');
});

test('a profile guess from the start command, before the first connection', () => {
  assert.equal(profileFromCommand('openclaw acp --session agent:main:somora-{session}')?.name, 'openclaw');
  assert.equal(profileFromCommand('/home/u/.local/bin/hermes acp')?.name, 'hermes');
  assert.equal(profileFromCommand('hermes-acp')?.name, 'hermes');
  assert.equal(profileFromCommand('goose acp'), null);
  assert.equal(profileFromCommand('my-openclaw-wrapper'), null);
});

test('somora → ACP: a text that stops extending (a stopped turn) adds only what differs, once', () => {
  const s = new SomoraToAcp();
  const e = (text: string, kind = 'assistant_delta') => ({ ts: 1, engine: 'x', kind, text }) as NormalizedEvent;
  const pieces = [
    ...s.update(e('You said: ans')),
    ...s.update(e('You said: answer slowly')),
    ...s.update(e('You said: answer [somora] aborted by user', 'assistant_message')),
    ...s.update(e('You said: answer [somora] aborted by user', 'assistant_message')),
  ].map((u) => (u as any).content.text);
  assert.deepEqual(pieces, ['You said: ans', 'wer slowly', '\n[somora] aborted by user']);
});

test('live stream → ACP: tools pair by name in order, a trivial success closes at the end, todos become the plan', () => {
  const tr = new SseToAcp('x');
  const f = (event: string, data: Record<string, unknown>) => tr.update({ event, data });
  const out = [
    ...f('tool', { phase: 'call', tool: 'exec', summary: 'ls' }),
    ...f('tool', { phase: 'call', tool: 'memory_write', summary: '{}' }),
    ...f('tool', { phase: 'call', tool: 'exec', summary: 'pwd' }),
    ...f('tool', { phase: 'result', tool: 'exec', summary: 'a b' }),
    ...f('tool', { phase: 'error', tool: 'exec', error: 'boom' }),
    ...f('todo_updated', { todos: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'weird', priority: 'high' }] }),
    ...f('chat', { state: 'delta', text: 'Done' }),
    ...f('status', { msg: 'error: rate limited' }),
  ];
  const calls = out.filter((u) => u.sessionUpdate === 'tool_call') as any[];
  assert.deepEqual(calls.map((c) => c.title), ['exec: ls', 'memory_write', 'exec: pwd']);
  const ups = out.filter((u) => u.sessionUpdate === 'tool_call_update') as any[];
  assert.deepEqual(ups.map((u) => [u.toolCallId, u.status]), [['x1', 'completed'], ['x3', 'failed']]);
  const plan = out.find((u) => u.sessionUpdate === 'plan') as any;
  assert.deepEqual(plan.entries, [{ content: 'one', status: 'in_progress', priority: 'medium' }, { content: 'two', status: 'pending', priority: 'high' }]);
  assert.deepEqual(tr.errors, ['rate limited']);
  const end = tr.finish({ event: 'agent', data: { phase: 'end', usage: { context_tokens: 900 }, contextWindow: 32000 } }) as any[];
  assert.deepEqual(end.map((u) => [u.sessionUpdate, u.toolCallId ?? u.used]), [['tool_call_update', 'x2'], ['usage_update', 900]]);
  assert.equal(tr.lastToolCall?.id, 'x3');
});

test('a stopped turn ends with the text so far and the marker every engine uses', () => {
  const tr = new AcpTurnTranslator('t', 'acp', () => 1);
  tr.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Counting: 1 2' } });
  const msg = tr.finish('cancelled').find((e) => e.kind === 'assistant_message') as { text: string };
  assert.equal(msg.text, 'Counting: 1 2\n\n[somora] aborted by user');
  const empty = new AcpTurnTranslator('t', 'acp', () => 1).finish('cancelled').find((e) => e.kind === 'assistant_message') as { text: string };
  assert.equal(empty.text, '[somora] aborted by user');
});
