// The judge's reply parsing, the coverage question and model resolution.
// Run: npx tsx src/dream/judge.test.mts
import { buildCoverageQuestion, COVERAGE_OPTIONS, parseJudgeReply, resolveJudgeModel } from './judge.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

// ── parseJudgeReply ──
let a = parseJudgeReply('{"answer":"covered","confidence":92,"by":2,"why":"same fact"}', COVERAGE_OPTIONS);
check('plain JSON', a.answer === 'covered' && a.confidence === 92 && a.by === 2 && a.why === 'same fact', JSON.stringify(a));
a = parseJudgeReply('Sure, here is my answer:\n```json\n{"answer": "adds_new", "confidence": "85", "by": null, "why": "new date"}\n```', COVERAGE_OPTIONS);
check('JSON inside prose and a code fence', a.answer === 'adds_new' && a.confidence === 85 && a.by === undefined, JSON.stringify(a));
a = parseJudgeReply('{"answer":"COVERED","confidence":150,"by":"[3]","why":"x"}', COVERAGE_OPTIONS);
check('case-insensitive option, confidence clamped, by from "[3]"', a.answer === 'covered' && a.confidence === 100 && a.by === 3, JSON.stringify(a));
a = parseJudgeReply('{"answer":"maybe","confidence":50}', COVERAGE_OPTIONS);
check('unknown option → null answer', a.answer === null && /not one of the options/.test(a.why), JSON.stringify(a));
a = parseJudgeReply('no json here', COVERAGE_OPTIONS);
check('no JSON → null answer, raw kept', a.answer === null && a.raw === 'no json here', JSON.stringify(a));
a = parseJudgeReply('{"answer":"covered"}', COVERAGE_OPTIONS);
check('missing confidence → 0', a.answer === 'covered' && a.confidence === 0);

// ── buildCoverageQuestion ──
const q = buildCoverageQuestion({ reason: 'user said so', content: 'A'.repeat(5000) }, [{ id: 'wiki:x', text: 'B'.repeat(10000) }, { id: 'memory:y', text: 'short' }], { maxPageChars: 6000 });
check('English, JSON-only instruction, both options named', /JSON only/.test(q.system) && /"covered"/.test(q.system) && /"adds_new"/.test(q.system));
check('adds_new is defined by facts none of the texts state', /none of the existing texts state/.test(q.system));
check('texts numbered with their ids', /\[1\] wiki:x/.test(q.user) && /\[2\] memory:y/.test(q.user));
check('content capped at 4000, page at maxPageChars', q.user.indexOf('A'.repeat(4001)) < 0 && q.user.indexOf('B'.repeat(6001)) < 0 && q.user.includes('B'.repeat(6000)));
check('options are the coverage pair', q.options.join(',') === 'covered,adds_new');
const q2 = buildCoverageQuestion({ reason: 'r', content: '' }, [], undefined);
check('empty content says so', /no content/.test(q2.user));

// ── resolveJudgeModel ──
const phase = { providerName: 'p', provider: { engine: 'openai-compatible' }, modelId: 'm', model: {} } as never;
check('no ref → the phase model', resolveJudgeModel({ providers: {} } as never, undefined, phase) === phase);
let threw = '';
try {
  resolveJudgeModel({ providers: {} } as never, 'no-such-alias', phase);
} catch (e) {
  threw = (e as Error).message;
}
check('bad ref → throws naming the ref', /no-such-alias/.test(threw), threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
