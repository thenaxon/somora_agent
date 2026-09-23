// Mid-turn compaction: which rounds are replaced, what the worker sees,
// what the model gets back.
// Run: npm test src/compaction/midturn.test.mts
import assert from 'node:assert/strict';
import { compactTurnMidway, lastRoundsStart, renderRoundsTranscript, type LoopMessage } from './midturn.ts';
import type { ResolvedModel } from '../config/types.ts';

const sys: LoopMessage = { role: 'system', content: 'S' };
const hist: LoopMessage = { role: 'user', content: 'earlier turn' };
const histA: LoopMessage = { role: 'assistant', content: 'earlier answer' };
const turn: LoopMessage = { role: 'user', content: 'build the thing' };
const round = (i: number): LoopMessage[] => [
  { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, function: { name: i % 2 ? 'file_patch' : 'exec', arguments: JSON.stringify({ path: `f${i}.ts` }) } }] },
  { role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify({ ok: true, round: i }) },
];
const messages: LoopMessage[] = [sys, hist, histA, turn, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(round)];
const turnStartIdx = 3;

// last 6 rounds start at round 5's assistant message
const cutAt = lastRoundsStart(messages, turnStartIdx + 1, 6);
assert.equal(cutAt, turnStartIdx + 1 + 4 * 2);
assert.equal(lastRoundsStart(messages, turnStartIdx + 1, 10), -1, 'nothing to compact with 10 rounds kept');

// transcript names the tools and results
const t = renderRoundsTranscript(messages.slice(turnStartIdx, cutAt));
assert.match(t, /\[User\]: build the thing/);
assert.match(t, /\[Assistant tool call\]: file_patch\(/);
assert.match(t, /\[Tool result exec\]: \{"ok":true,"round":2\}/);

const worker = { providerName: 'p', modelId: 'm', provider: { engine: 'openai-compatible' }, model: { contextWindow: 100_000 } } as unknown as ResolvedModel;
const r = await compactTurnMidway({
  messages,
  turnStartIdx,
  keepRounds: 6,
  resolvedModel: worker,
  availableModels: [worker],
  config: { triggerRatio: 0.8, safetyCushionPairs: 4 } as never,
  agent: 'rudi',
  summarize: async (_w, system, user) => {
    assert.match(system, /## Work State/);
    assert.match(user, /<transcript>/);
    return { text: '## Objective\n- build the thing\n## Next Move\n1. round 5' };
  },
});
assert.ok(r);
assert.equal(r!.compactedMessages, 8, 'rounds 1-4 = 8 messages replaced');
// shape: system, history, the turn's user message, the summary block, then rounds 5-10 verbatim
assert.equal(r!.messages[0], sys);
assert.equal(r!.messages[3], turn);
assert.equal(r!.messages[4]!.role, 'user');
assert.match(String(r!.messages[4]!.content), /compacted to keep the conversation/);
assert.match(String(r!.messages[4]!.content), /## Next Move/);
assert.equal(r!.messages.length, 4 + 1 + 6 * 2);
assert.equal((r!.messages[5] as LoopMessage).tool_calls?.[0]?.id, 'c5');

// a worker that fails → null, nothing changed
const none = await compactTurnMidway({
  messages,
  turnStartIdx,
  keepRounds: 6,
  resolvedModel: worker,
  availableModels: [worker],
  config: { triggerRatio: 0.8, safetyCushionPairs: 4 } as never,
  agent: 'rudi',
  summarize: async () => {
    throw new Error('down');
  },
});
assert.equal(none, null);
console.log('midturn.test: ok');
