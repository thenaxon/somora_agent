// Fallback chain: primary → fallback[0] → fallback[1] …, each hop only
// when the previous model died before producing anything. Fake engine
// registered in place of openai-compatible; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineRegistry } from '../engine/registry.ts';
import { runTurnWithFallback } from './run-turn-fallback.ts';
import { listUnavailableModels, markModelUnavailable, modelUnavailable, resetModelAvailability } from '../engine/model-availability.ts';

const mk = (id: string): any => ({ id, alias: id, contextWindow: 1000, capabilities: ['text'] });
const config: any = {
  engineWatchdog: { claudeCliIdleMs: 1, codexCliIdleMs: 1, grokCliIdleMs: 1, openaiCompatibleIdleMs: 1 },
  providers: {
    a: { engine: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k', models: [mk('m1'), mk('m2'), mk('m3')] },
  },
};
const rm = (id: string) => ({ providerName: 'a', modelId: id, model: mk(id), provider: config.providers.a });
// 'quota'    — provider streams its refusal as assistant text, then a
//              marked provider error (the 2026-09-09 Claude case).
// 'lateflop' — a real answer was streaming and then something broke.
// 'toolthen' — a tool already ran, so the turn had side effects.
type Behaviour = 'ok' | 'die' | 'quota' | 'lateflop' | 'toolthen';
const behaviour = new Map<string, Behaviour>();
(engineRegistry as any)['openai-compatible'] = {
  name: 'openai-compatible',
  async *runTurn(input: any) {
    const id = input.resolvedModel.modelId;
    const end = { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
    yield { kind: 'turn_start', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
    switch (behaviour.get(id)) {
      case 'die':
        yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `${id} down` };
        yield end;
        return;
      case 'quota':
        yield { kind: 'assistant_delta', ts: 1, engine: 'openai-compatible', text: 'Monthly quota exceeded.' };
        yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `${id} quota`, providerError: true };
        yield end;
        return;
      case 'lateflop':
        yield { kind: 'assistant_delta', ts: 1, engine: 'openai-compatible', text: 'here is half an answer' };
        yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `${id} flopped` };
        yield end;
        return;
      case 'toolthen':
        yield { kind: 'tool_call', ts: 1, engine: 'openai-compatible', name: 'file_write', id: 'c1', args: {} };
        yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `${id} died after writing`, providerError: true };
        yield end;
        return;
      default:
        yield { kind: 'assistant_message', ts: 1, engine: 'openai-compatible', text: `hi from ${id}` };
        yield end;
    }
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

// ── a provider failure dressed as an answer (2026-09-09) ────────────

test('a quota notice streamed as assistant text does not block the fallback', async () => {
  behaviour.set('m1', 'quota');
  behaviour.set('m2', 'ok');
  const out = await run(['m2']);
  const fb = out.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 1, 'the chain ran');
  assert.equal(fb[0].actual, 'a/m2');
  assert.match(fb[0].reason, /quota/);
  assert.ok(out.some((e) => e.kind === 'assistant_message' && e.text === 'hi from m2'));
  assert.equal(out.filter((e) => e.kind === 'error').length, 0, 'the failed attempt keeps its error to itself');
});

test('an ordinary failure after real output still ends the turn', async () => {
  behaviour.set('m1', 'lateflop');
  behaviour.set('m2', 'ok');
  const out = await run(['m2']);
  assert.equal(out.filter((e) => e.kind === 'model_fallback').length, 0, 'half an answer is not thrown away for a retry');
  assert.equal(out.filter((e) => e.kind === 'error').length, 1);
  assert.ok(!out.some((e) => e.kind === 'assistant_message' && e.text === 'hi from m2'));
});

test('a turn that already ran a tool is never repeated on another model', async () => {
  behaviour.set('m1', 'toolthen');
  behaviour.set('m2', 'ok');
  const out = await run(['m2']);
  assert.equal(out.filter((e) => e.kind === 'model_fallback').length, 0, 'side effects are not replayed');
  const errs = out.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /died after writing/);
});

test('a user abort is not a provider failure', async () => {
  behaviour.set('m1', 'quota');
  behaviour.set('m2', 'ok');
  const controller = new AbortController();
  controller.abort();
  const out: any[] = [];
  for await (const ev of runTurnWithFallback({
    primary: rm('m1'),
    fallbackRefs: ['m2'],
    baseInput: { signal: controller.signal } as any,
    config,
  })) {
    out.push(ev);
  }
  assert.equal(out.filter((e) => e.kind === 'model_fallback').length, 0, 'the user stopped it, do not spend another model');
});

// ── unavailable marks (2026-09-27): the dead primary is not knocked on every turn ──
test('a primary that died with a host error is marked, and the next turn starts on the backup', async () => {
  resetModelAvailability();
  behaviour.set('m1', 'die'); behaviour.set('m2', 'ok');
  // 'm1 down' is not a host error by wording; make it one
  (engineRegistry as any)['openai-compatible'].runTurn = async function* (input: any) {
    const id = input.resolvedModel.modelId;
    yield { kind: 'turn_start', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
    if (behaviour.get(id) === 'die') {
      yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: `500 litellm.InternalServerError: OpenAIException - Connection error (${id})` };
      yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
      return;
    }
    yield { kind: 'assistant_message', ts: 1, engine: 'openai-compatible', text: `hi from ${id}` };
    yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
  };
  const first = await run(['m2', 'm3']);
  assert.equal(first.filter((e) => e.kind === 'model_fallback').length, 1);
  assert.ok(modelUnavailable('a/m1') !== null, 'm1 marked after the host error');
  assert.equal(modelUnavailable('a/m2'), null, 'm2 answered, no mark');
  const second = await run(['m2', 'm3']);
  const fb = second.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 1, 'still one fallback event — the chip stays');
  assert.match(fb[0].reason, /not tried — marked unavailable since/);
  assert.equal(fb[0].actual, 'a/m2');
  assert.ok(!second.some((e) => e.kind === 'turn_start' && e.turnId === 't-m1'), 'm1 was not started at all');
  assert.ok(second.some((e) => e.kind === 'assistant_message' && e.text === 'hi from m2'));
});
test('when every model in the chain is marked, the chain runs as before', async () => {
  resetModelAvailability();
  markModelUnavailable('a/m1', 'x'); markModelUnavailable('a/m2', 'y'); markModelUnavailable('a/m3', 'z');
  behaviour.set('m1', 'ok');
  const out = await run(['m2', 'm3']);
  assert.ok(out.some((e) => e.kind === 'turn_start' && e.turnId === 't-m1'), 'm1 tried despite the mark');
  assert.equal(out.filter((e) => e.kind === 'model_fallback').length, 0);
  assert.equal(modelUnavailable('a/m1'), null, 'm1 answered → mark dropped');
});
test('a marked backup is skipped when a later one is free', async () => {
  resetModelAvailability();
  behaviour.set('m1', 'die'); behaviour.set('m2', 'ok'); behaviour.set('m3', 'ok');
  markModelUnavailable('a/m2', 'y');
  const out = await run(['m2', 'm3']);
  const fb = out.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].actual, 'a/m3');
  assert.equal(fb[0].hops.length, 2, 'the skipped backup is listed in the hops');
  assert.match(fb[0].hops[1].reason, /not tried/);
  assert.equal(listUnavailableModels().map((m) => m.ref).sort().join(','), 'a/m1,a/m2');
});
test('a plain refusal (4xx wording) marks nothing', async () => {
  resetModelAvailability();
  (engineRegistry as any)['openai-compatible'].runTurn = async function* (input: any) {
    const id = input.resolvedModel.modelId;
    yield { kind: 'turn_start', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
    if (id === 'm1') { yield { kind: 'error', ts: 1, engine: 'openai-compatible', message: '400 unsupported parameter reasoning_effort' }; yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-m1' }; return; }
    yield { kind: 'assistant_message', ts: 1, engine: 'openai-compatible', text: `hi from ${id}` };
    yield { kind: 'turn_end', ts: 1, engine: 'openai-compatible', turnId: 't-' + id };
  };
  await run(['m2']);
  assert.equal(modelUnavailable('a/m1'), null, 'a 400 is a config problem, not an outage');
});
