// Fallback chain: primary → fallback[0] → fallback[1] …, each hop only
// when the previous model died before producing anything. Fake engine
// registered in place of openai-compatible; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineRegistry } from '../engine/registry.ts';
import { runTurnWithFallback } from './run-turn-fallback.ts';

const mk = (id: string) => ({ id, alias: id, contextWindow: 1000, capabilities: ['text'] });
const config: any = {
  engineWatchdog: { claudeCliIdleMs: 1, codexCliIdleMs: 1, grokCliIdleMs: 1, openaiCompatibleIdleMs: 1 },
  providers: {
    a: { engine: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k', models: [mk('m1'), mk('m2'), mk('m3')] },
  },
};
const rm = (id: string) => ({ providerName: 'a', modelId: id, model: mk(id), provider: config.providers.a });
const behaviour = new Map<string, 'ok' | 'die'>();
(engineRegistry as any)['openai-compatible'] = {
  name: 'openai-compatible',
  async *runTurn(input: any) {
    const id = input.resolvedModel.modelId;
    yield { kind: 'turn_start', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
    if (behaviour.get(id) === 'die') {
      yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `${id} down` };
      yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
      return;
    }
    yield { kind: 'assistant_message', ts: 1, engine: 'openai-compatible', text: `hi from ${id}` };
    yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
  },
};
async function run(refs: string[]) {
  const out: any[] = [];
  for await (const ev of runTurnWithFallback({ primary: rm('m1'), fallbackRefs: refs, baseInput: {} as any, config })) out.push(ev);
  return out;
}
test('primary ok → no fallback event', async () => {
  behaviour.set('m1', 'ok');
  const out = await run(['m2', 'm3']);
  assert.equal(out.filter((e) => e.kind === 'model_fallback').length, 0);
  assert.ok(out.some((e) => e.kind === 'assistant_message' && e.text === 'hi from m1'));
});
test('primary + first fallback die → third answers, hops carry the chain', async () => {
  behaviour.set('m1', 'die'); behaviour.set('m2', 'die'); behaviour.set('m3', 'ok');
  const out = await run(['m2', 'm3']);
  const fb = out.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 2);
  assert.equal(fb[1].requested, 'a/m1');
  assert.equal(fb[1].actual, 'a/m3');
  assert.deepEqual(fb[1].hops.map((h: any) => h.model), ['a/m1', 'a/m2']);
  assert.ok(out.some((e) => e.kind === 'assistant_message' && e.text === 'hi from m3'));
  assert.equal(out.filter((e) => e.kind === 'error').length, 0);
});
test('all die → one error naming every model + turn_end', async () => {
  behaviour.set('m1', 'die'); behaviour.set('m2', 'die'); behaviour.set('m3', 'die');
  const out = await run(['m2', 'm3']);
  const errs = out.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /All 3 models failed/);
  assert.match(errs[0].message, /a\/m1: m1 down/);
  assert.match(errs[0].message, /a\/m3: m3 down/);
  assert.equal(out[out.length - 1].kind, 'turn_end');
});
test('unresolvable ref is skipped, chain continues', async () => {
  behaviour.set('m1', 'die'); behaviour.set('m3', 'ok');
  const out = await run(['nope', 'm3']);
  const fb = out.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].actual, 'a/m3');
  assert.deepEqual(fb[0].hops.map((h: any) => h.model), ['a/m1', 'nope']);
});
test('no fallback → primary error + turn_end (legacy behaviour)', async () => {
  behaviour.set('m1', 'die');
  const out = await run([]);
  assert.deepEqual(out.map((e) => e.kind), ['turn_start', 'error', 'turn_end']);
  assert.equal(out[1].message, 'm1 down');
});
