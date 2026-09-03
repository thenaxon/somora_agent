// Run: npx tsx src/memory/retrieval-fts.test.mts
import assert from 'node:assert/strict';
import { sanitizeFtsQuery, FTS_MAX_TERMS } from './retrieval.ts';
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') => { if (c) pass++; else { fail++; console.error('FAIL', n, d); } };
const terms = (q: string) => (q ? q.split(' OR ') : []);
check('empty → empty', sanitizeFtsQuery('') === '');
check('short tokens dropped', sanitizeFtsQuery('a b cd') === '"cd"');
check('quoted OR-joined', sanitizeFtsQuery('spiderman GPU node') === '"spiderman" OR "gpu" OR "node"');
check('dedupe keeps first occurrence', sanitizeFtsQuery('foo bar foo baz bar') === '"foo" OR "bar" OR "baz"');
{
  const words = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
  const q = sanitizeFtsQuery(words);
  check(`cap at FTS_MAX_TERMS (${FTS_MAX_TERMS})`, terms(q).length === FTS_MAX_TERMS, String(terms(q).length));
  check('cap keeps the first terms', q.startsWith('"w0" OR "w1"'));
}
{
  const big = 'alpha beta '.repeat(20000); // 220k chars, 2 distinct terms
  const t0 = Date.now(); const q = sanitizeFtsQuery(big); const ms = Date.now() - t0;
  check('275k-char input with 2 distinct terms → 2 terms', terms(q).length === 2);
  check('sanitize itself is fast', ms < 500, `${ms} ms`);
}
check('custom cap honoured', terms(sanitizeFtsQuery('a1 b2 c3 d4 e5', 3)).length === 3);
check('unicode letters survive', sanitizeFtsQuery('Rechnung März bezahlt') === '"rechnung" OR "märz" OR "bezahlt"');
console.log(`${pass} passed, ${fail} failed`); assert.equal(fail, 0);
