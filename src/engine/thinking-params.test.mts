// Tests for the openai-compatible reasoning-effort mapping + fallback (2026-09-02).
//
// Run: npx tsx src/engine/thinking-params.test.mts

import assert from 'node:assert/strict';

import {
  isReasoningEffortError,
  openAiReasoningParam,
  parseSupportedEfforts,
  pickFallbackEffort,
  resolveOpenAiReasoning,
} from './thinking-params.ts';

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

const reasoningModel = { capabilities: ['text', 'reasoning'] };
const plainModel = { capabilities: ['text'] };

// ── legacy mapping without a reasoning block ───────────────────────────
check('no level → no param', eq(openAiReasoningParam(undefined, reasoningModel), {}));
check('off → param omitted', eq(openAiReasoningParam('off', reasoningModel), {}));
check('high → reasoning_effort high', eq(openAiReasoningParam('high', reasoningModel), { reasoning_effort: 'high' }));
check('non-reasoning model → nothing', eq(openAiReasoningParam('high', plainModel), {}));
check('resolve reports value', resolveOpenAiReasoning('medium', reasoningModel).value === 'medium');
check('resolve reports null for off', resolveOpenAiReasoning('off', reasoningModel).value === null);

// ── per-model vocabulary (the Qwen case) ───────────────────────────────
{
  const qwen = {
    capabilities: ['text', 'reasoning'],
    reasoning: { levels: { off: null, low: 'low', medium: 'medium', high: 'xhigh' } },
  };
  check('high → xhigh via levels', eq(openAiReasoningParam('high', qwen), { reasoning_effort: 'xhigh' }));
  check('off: null → omitted', eq(openAiReasoningParam('off', qwen), {}));
  check('low passes through', eq(openAiReasoningParam('low', qwen), { reasoning_effort: 'low' }));
  check('resolve value is the wire word', resolveOpenAiReasoning('high', qwen).value === 'xhigh');
}
{
  const partial = { capabilities: ['reasoning'], reasoning: { levels: { high: 'max' } } };
  check('missing levels keep legacy mapping', eq(openAiReasoningParam('medium', partial), { reasoning_effort: 'medium' }));
  check('off with no entry stays omitted', eq(openAiReasoningParam('off', partial), {}));
  check('configured high → max', eq(openAiReasoningParam('high', partial), { reasoning_effort: 'max' }));
}
{
  const offLow = { capabilities: ['reasoning'], reasoning: { levels: { off: 'low' } } };
  check('off can be mapped to a real value', eq(openAiReasoningParam('off', offLow), { reasoning_effort: 'low' }));
}

// ── wire shapes ────────────────────────────────────────────────────────
{
  const or = { capabilities: ['reasoning'], reasoning: { param: 'reasoning' as const } };
  check('openrouter nested shape', eq(openAiReasoningParam('low', or), { reasoning: { effort: 'low' } }));
  const kw = { capabilities: ['reasoning'], reasoning: { param: 'chat_template_kwargs' as const } };
  check('chat_template_kwargs shape', eq(openAiReasoningParam('low', kw), { chat_template_kwargs: { reasoning_effort: 'low' } }));
  check('off omits regardless of shape', eq(openAiReasoningParam('off', or), {}));
}

// ── error classification + parsing ─────────────────────────────────────
const qwenErr = new Error(
  '400 {"object":"error","message":"Unexpected reasoning effort high. Supported: xhigh, medium, low","type":"BadRequestError"}',
);
check('qwen 400 is a reasoning-effort error', isReasoningEffortError(qwenErr));
check('context error is not', !isReasoningEffortError(new Error('prompt too long: 200000 tokens')));
check('openai unsupported-value wording', isReasoningEffortError(new Error("Unsupported value: 'xhigh' is not supported with this model. Supported values are: 'low', 'medium', and 'high' for parameter 'reasoning_effort'")));
check('parse qwen list', eq(parseSupportedEfforts(qwenErr.message), ['xhigh', 'medium', 'low']));
check(
  'parse openai list with quotes and "and"',
  eq(parseSupportedEfforts("Supported values are: 'low', 'medium', and 'high' for parameter 'reasoning_effort'"), ['low', 'medium', 'high']),
);
check('parse: nothing named → null', parseSupportedEfforts('reasoning_effort is not supported by this model') === null);

// ── neighbour pick ─────────────────────────────────────────────────────
check('high → xhigh? no: nearest weaker first → medium', pickFallbackEffort('high', ['xhigh', 'medium', 'low']) === 'medium');
check('requested supported → unchanged', pickFallbackEffort('low', ['xhigh', 'medium', 'low']) === 'low');
check('minimal → low when only low+ exist', pickFallbackEffort('minimal', ['low', 'high', 'max']) === 'low');
check('never picks none', pickFallbackEffort('minimal', ['none', 'medium']) === 'medium');
check('unknown requested word → treated as medium → low', pickFallbackEffort('turbo', ['low', 'high', 'max']) === 'low');
check('nothing usable → null', pickFallbackEffort('high', ['none']) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
