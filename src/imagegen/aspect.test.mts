// Tests for aspect-ratio handling on the OpenAI image wire (aspect.ts).
//
// Run: npx tsx src/imagegen/aspect.test.mts

import assert from 'node:assert/strict';
import { ratioMismatch, ratioValue, requestedRatio, translateAspectForOpenAiWire } from './aspect.ts';
import type { ModelCapabilities } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const cerebro: ModelCapabilities = {
  known: true,
  source: 'catalog',
  values: { aspect_ratio: ['1:1', '16:9', '9:16'] },
  sizeAlsoAccepts: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'],
  supported: ['size', 'aspect_ratio', 'n'],
};
const listedSizes: ModelCapabilities = { known: true, source: 'catalog', values: { size: ['1024x1024', '1536x864', '864x1536'] } };
const unknown: ModelCapabilities = { known: false, source: 'unknown', values: {} };

// ── ratioValue ────────────────────────────────────────────────────────
check('16:9 parses', Math.abs((ratioValue('16:9') ?? 0) - 16 / 9) < 1e-9);
check('garbage is null', ratioValue('wide') === null && ratioValue('0:1') === null && ratioValue(undefined) === null);

// ── translation ───────────────────────────────────────────────────────
{
  const r = translateAspectForOpenAiWire({ aspect_ratio: '16:9', seed: 7 }, cerebro);
  check('catalog ratio → size carries the ratio string', r.specs.size === '16:9' && r.specs.aspect_ratio === undefined, JSON.stringify(r));
  check('other specs survive', r.specs.seed === 7);
  check('translation reported exact via catalog-ratio', r.translated?.via === 'catalog-ratio' && r.translated.exact === true);

  const r2 = translateAspectForOpenAiWire({ aspect_ratio: '16:9' }, listedSizes);
  check('listed sizes → closest listed shape', r2.specs.size === '1536x864' && r2.translated?.via === 'catalog-size' && r2.translated.exact === true, JSON.stringify(r2));

  const r3 = translateAspectForOpenAiWire({ aspect_ratio: '16:9' }, unknown);
  check('no catalog → OpenAI table, marked inexact', r3.specs.size === '1792x1024' && r3.translated?.via === 'openai-table' && r3.translated.exact === false, JSON.stringify(r3));

  const r4 = translateAspectForOpenAiWire({ aspect_ratio: '1:1' }, unknown);
  check('1:1 on the table is exact', r4.specs.size === '1024x1024' && r4.translated?.exact === true);

  const r5 = translateAspectForOpenAiWire({ aspect_ratio: '16:9', size: '800x600' }, cerebro);
  check('explicit size wins, ratio dropped silently', r5.specs.size === '800x600' && r5.specs.aspect_ratio === undefined && !r5.translated);

  const r6 = translateAspectForOpenAiWire({ size: '1024x1024' }, cerebro);
  check('no ratio → untouched', r6.specs.size === '1024x1024' && !r6.translated && !r6.dropped);

  const r7 = translateAspectForOpenAiWire({ aspect_ratio: 'wide' }, unknown);
  check('unparseable ratio without named sizes is dropped with a reason', r7.specs.aspect_ratio === undefined && !!r7.dropped);

  const r8 = translateAspectForOpenAiWire({ aspect_ratio: '21:9' }, unknown);
  check('unknown ratio picks the closest table entry', r8.specs.size === '1792x1024' && r8.translated?.exact === false, JSON.stringify(r8));
}

// ── mismatch check ────────────────────────────────────────────────────
check('requestedRatio from aspect_ratio', Math.abs((requestedRatio({ aspect_ratio: '4:3' }) ?? 0) - 4 / 3) < 1e-9);
check('requestedRatio from a named size', Math.abs((requestedRatio({ size: '16:9' }) ?? 0) - 16 / 9) < 1e-9);
check('requestedRatio ignores pixel sizes', requestedRatio({ size: '1024x768' }) === null);
check('1024² for 16:9 is a mismatch', ratioMismatch(16 / 9, 1024, 1024));
check('1536×864 for 16:9 is fine', !ratioMismatch(16 / 9, 1536, 864));
check('1792×1024 for 16:9 is a mismatch (7:4)', ratioMismatch(16 / 9, 1792, 1024));

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
