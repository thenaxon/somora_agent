// Memory blocks in a long session: a note section the model still has
// in context is not injected again, and after a pause the old blocks
// leave the replayed history (openai-compatible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SOMORA_HOME ??= `/tmp/somora-inject-repeats-${process.pid}`;
const { injectMemoryContext, injectedKeysInHistory, withoutMemoryBlock } = await import('./inject.ts');
const { buildMessages } = await import('../engine/openai-compatible.ts');

const hit = (slug: string, text: string, score = 0.6) => ({ source: 'wiki', slug, score, text } as never);
const pool = [hit('people/karl', 'Karl Muster lives in Musterstadt.\n\nHe has two dogs.'), hit('places/garden', 'The garden gate code is 4711.', 0.55), hit('people/nina', 'Nina takes over the allotment.', 0.5), hit('notes/water', 'Water is off from November.', 0.45)];
const mgr = { search: async (_q: string, o: { limit: number }) => pool.slice(0, o.limit) } as never;
const cfg = { queryTurns: 3, maxResults: 2, minScore: 0.35, maxTokens: 1500, historyWeight: 0.3, historyWeightShort: 0.55, historyWeightEmpty: 0.8, historyTurnChars: 800, shortQueryBm25Weight: 0.5, skipRepeats: true };
const userEv = (ts: number, ephemeral: string, text = 'q') => ({ kind: 'user_message', ts, engine: 'openai-compatible', text, ephemeral } as never);

test('repeats are left out and their places go to the next hits', async () => {
  const first = await injectMemoryContext({ mgr, history: [], userMessage: 'tell me about karl and the garden', cfg });
  assert.equal(first.injectedCount, 2);
  const history = [userEv(1000, `[turn framing]\n\n${first.ephemeralContext}`)];
  const seen = injectedKeysInHistory(history, 0);
  assert.equal(seen.size, 2, 'both sections recognised, also the one with a blank line inside');
  const second = await injectMemoryContext({ mgr, history, userMessage: 'and the garden again', cfg, alreadyInContext: seen });
  assert.equal(second.skippedRepeats, 2);
  assert.deepEqual(second.hits.map((h: { slug: string }) => h.slug), ['people/nina', 'notes/water']);
});

test('everything already shown: no block at all', async () => {
  const all = await injectMemoryContext({ mgr, history: [], userMessage: 'x', cfg: { ...cfg, maxResults: 4 } });
  const seen = injectedKeysInHistory([userEv(1, all.ephemeralContext!)], 0);
  const again = await injectMemoryContext({ mgr, history: [], userMessage: 'x', cfg: { ...cfg, maxResults: 4 }, alreadyInContext: seen });
  assert.equal(again.ephemeralContext, undefined);
  assert.equal(again.skippedRepeats, 4);
});

test('blocks before the boundary do not count, and skipRepeats: false turns it off', async () => {
  const first = await injectMemoryContext({ mgr, history: [], userMessage: 'x', cfg });
  const history = [userEv(1000, first.ephemeralContext!)];
  assert.equal(injectedKeysInHistory(history, 1000).size, 0, 'at or before the compaction / drop point');
  const off = await injectMemoryContext({ mgr, history, userMessage: 'x', cfg: { ...cfg, skipRepeats: false }, alreadyInContext: injectedKeysInHistory(history, 0) });
  assert.equal(off.skippedRepeats, 0);
  assert.equal(off.injectedCount, 2);
});

test('the replay drops memory blocks of turns before the drop point, keeps their framing', async () => {
  const first = await injectMemoryContext({ mgr, history: [], userMessage: 'x', cfg });
  const eph = `[system: framing]\n\n${first.ephemeralContext}`;
  assert.equal(withoutMemoryBlock(eph), '[system: framing]');
  const history = [
    userEv(1000, eph, 'old question'),
    { kind: 'assistant_message', ts: 1100, engine: 'openai-compatible', text: 'old answer' } as never,
    userEv(5000, eph, 'new question'),
  ];
  const caps = ['text'] as never;
  const kept = (await buildMessages('SYS', history, undefined, 'rasterize', caps, 2048, 0)) as Array<{ role: string; content: string }>;
  const dropped = (await buildMessages('SYS', history, undefined, 'rasterize', caps, 2048, 3000)) as Array<{ role: string; content: string }>;
  const users = (m: Array<{ role: string; content: string }>) => m.filter((x) => x.role === 'user').map((x) => String(x.content));
  assert.equal(users(kept).filter((c) => c.includes('<memory-context>')).length, 2);
  const d = users(dropped);
  assert.ok(!d[0]!.includes('<memory-context>') && d[0]!.includes('[system: framing]') && d[0]!.includes('old question'));
  assert.ok(d[1]!.includes('<memory-context>'), 'turns after the drop point keep theirs');
});
