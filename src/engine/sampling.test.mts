// Tests for sampling merge / body / error classification (Paket B, 2026-09-02).
//
// Run: npx tsx src/engine/sampling.test.mts

import assert from 'node:assert/strict';

import { formatSampling, isSamplingParamError, mergeSampling, samplingBody } from './sampling.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── merge precedence ───────────────────────────────────────────────────
check('nothing set → undefined', mergeSampling(undefined, null, {}) === undefined);
check(
  'later layer wins per key, earlier keys survive',
  eq(mergeSampling({ temperature: 0.2, top_p: 0.9 }, { temperature: 1.0 }), { temperature: 1.0, top_p: 0.9 }),
);
check('null in a later layer drops the key', eq(mergeSampling({ temperature: 0.2, top_p: 0.9 }, { temperature: null }), { top_p: 0.9 }));
check('null on an unset key is a no-op', mergeSampling({ temperature: null }) === undefined);
check('unknown keys are ignored', eq(mergeSampling({ temperature: 1, bogus: 3 } as never), { temperature: 1 }));
check('undefined in a later layer keeps the earlier value', eq(mergeSampling({ top_k: 40 }, { top_k: undefined }), { top_k: 40 }));

// ── body + format ──────────────────────────────────────────────────────
check('body is empty for undefined', eq(samplingBody(undefined), {}));
check('body keeps wire names', eq(samplingBody({ temperature: 1, top_p: 0.95, stop: ['\n\n'] }), { temperature: 1, top_p: 0.95, stop: ['\n\n'] }));
check('format in canonical order', formatSampling({ top_p: 0.95, temperature: 1 }) === 'temperature=1 top_p=0.95');
check('format stop list', formatSampling({ stop: ['a', 'b'] }) === 'stop=a,b');
check('format empty', formatSampling(undefined) === '');

// ── error classification ───────────────────────────────────────────────
check('openai unsupported temperature', isSamplingParamError(new Error("400 Unsupported parameter: 'temperature' is not supported with this model.")));
check('vllm top_k range', isSamplingParamError(new Error('400 top_k must be -1 (disable), or at least 1, got 0.')));
check('litellm unsupported param', isSamplingParamError(new Error('400 litellm.UnsupportedParamsError: repetition_penalty is not supported by openai')));
check('context overflow is not', !isSamplingParamError(new Error("400 This model's maximum context length is 8192 tokens")));
check('reasoning effort error is not', !isSamplingParamError(new Error('400 Unexpected reasoning effort high. Supported: xhigh, medium, low')));
check('auth error is not', !isSamplingParamError(new Error('401 Incorrect API key provided')));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
