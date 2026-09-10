// The compaction worker cascade (2026-09-10).
//
// Run: npx tsx src/compaction/worker-cascade.test.mts
//
// Live incident: the one worker somora picked was refused by its host's
// memory guard ("prefill memory guard rejected this prompt"), the whole
// compaction was declared failed, the oversized prompt still did not fit
// and the turn fell through to a different chat model. A refusal by one
// worker must cost one attempt, not the compaction.

import assert from 'node:assert/strict';

import { MAX_WORKER_ATTEMPTS, rankCompactionModels, runCompaction } from './summarize.ts';
import type { CompactionConfig } from './types.ts';
import type { ResolvedModel } from '../config/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const model = (alias: string, contextWindow: number, provider = 'local'): ResolvedModel =>
  ({
    providerName: provider,
    modelId: alias,
    model: { alias, contextWindow },
    provider: { engine: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k' },
  }) as unknown as ResolvedModel;

const small = model('small', 131_072);
const small2 = model('small2', 131_072);
const mid = model('mid', 262_144);
const big = model('big', 700_000);
const all = [small, small2, mid, big];

const refs = (ms: ResolvedModel[]): string[] => ms.map((m) => m.model.alias!);

// ── auto-pick: every fitting window, smallest first ───────────────────
{
  const ranked = rankCompactionModels(25_000, all);
  check('auto-pick keeps all fitting candidates', ranked.length === 4, refs(ranked).join(','));
  check('auto-pick starts at the smallest window', refs(ranked)[0] === 'small', refs(ranked)[0]);
  check('auto-pick ends at the largest', refs(ranked).at(-1) === 'big', String(refs(ranked).at(-1)));
}

// ── auto-pick drops windows that cannot hold the summary prompt ───────
{
  const ranked = rankCompactionModels(300_000, all);
  check('too-small windows are dropped', refs(ranked).join(',') === 'big', refs(ranked).join(','));
}

// ── a configured list IS the cascade, in its own order ───────────────
{
  const ranked = rankCompactionModels(25_000, all, { workers: ['big', 'small2'] });
  check('configured order wins', refs(ranked).join(',') === 'big,small2', refs(ranked).join(','));
  check('models left out never appear', !refs(ranked).includes('small'));
}

// ── a listed model is honored even when its window looks too small ────
{
  const ranked = rankCompactionModels(300_000, all, { workers: ['small'] });
  check('operator intent beats the window check', refs(ranked).join(',') === 'small', refs(ranked).join(','));
}

// ── an entry that matches nothing is skipped, the rest still runs ─────
{
  const ranked = rankCompactionModels(25_000, all, { workers: ['typo', 'mid'] });
  check('unresolvable entry skipped', refs(ranked).join(',') === 'mid', refs(ranked).join(','));
}

// ── the override goes first and is never duplicated ──────────────────
{
  const ranked = rankCompactionModels(25_000, all, { override: mid, workers: ['small', 'mid'] });
  check('override leads the cascade', refs(ranked).join(',') === 'mid,small', refs(ranked).join(','));
}

// ── the cascade itself: worker 1 refuses, worker 2 delivers ──────────
const history: NormalizedEvent[] = [];
for (let i = 1; i <= 12; i++) {
  history.push({ kind: 'user_message', ts: i * 10, text: `U${i}` } as NormalizedEvent);
  history.push({ kind: 'assistant_message', ts: i * 10 + 1, text: `A${i}` } as NormalizedEvent);
}
const config = { triggerRatio: 0.8, safetyCushionPairs: 4 } as CompactionConfig;

{
  const asked: string[] = [];
  const result = await runCompaction({
    systemPrompt: 'sys',
    history,
    resolvedModel: big,
    availableModels: all,
    compactions: undefined,
    config,
    summarize: async (worker) => {
      asked.push(worker.model.alias!);
      if (asked.length === 1) throw new Error('oMLX prefill memory guard rejected this prompt');
      return { text: 'summary text' };
    },
  });
  check('the refusal did not end the compaction', result?.summary === 'summary text', JSON.stringify(result));
  check('two workers were asked', asked.length === 2, asked.join(','));
  check('the second worker is credited', result?.byModel === 'local/small2', String(result?.byModel));
}

// ── everyone refuses: one error naming every attempt ─────────────────
{
  const asked: string[] = [];
  let message = '';
  try {
    await runCompaction({
      systemPrompt: 'sys',
      history,
      resolvedModel: big,
      availableModels: all,
      compactions: undefined,
      config,
      summarize: async (worker) => {
        asked.push(worker.model.alias!);
        throw new Error(`no room on ${worker.model.alias}`);
      },
    });
  } catch (e) {
    message = String((e as Error).message);
  }
  check('the cascade stops at the cap', asked.length === MAX_WORKER_ATTEMPTS, asked.join(','));
  check('the error names every attempt', asked.every((a) => message.includes(a)), message);
}

// ── a configured list shorter than the cap is not padded ─────────────
{
  const asked: string[] = [];
  try {
    await runCompaction({
      systemPrompt: 'sys',
      history,
      resolvedModel: big,
      availableModels: all,
      compactions: undefined,
      config: { ...config, workers: ['mid'] },
      summarize: async (worker) => {
        asked.push(worker.model.alias!);
        throw new Error('nope');
      },
    });
  } catch {
    /* expected */
  }
  check('only the listed worker is asked', asked.join(',') === 'mid', asked.join(','));
}

console.log(`\nworker-cascade: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
