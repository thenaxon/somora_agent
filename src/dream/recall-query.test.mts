// Run: npx tsx src/dream/recall-query.test.mts
import assert from 'node:assert/strict';
import { buildVaultRecallQuery, RECALL_QUERY_MAX_MESSAGES, RECALL_QUERY_MAX_CHARS } from './rem-runner.ts';
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') => { if (c) pass++; else { fail++; console.error('FAIL', n, d); } };
const um = (text: string, from_agent?: string) => ({ kind: 'user_message', text, ...(from_agent ? { from_agent } : {}) });
check('empty', buildVaultRecallQuery([]) === '');
check('only user messages', buildVaultRecallQuery([um('hello'), { kind: 'assistant_message', text: 'hi' }, { kind: 'tool_call', text: 'x' }]) === 'hello');
check('A2A messages excluded', buildVaultRecallQuery([um('human'), um('from other agent', 'lisa')]) === 'human');
{
  const evs = Array.from({ length: 900 }, (_, i) => um(`msg${i}`));
  const q = buildVaultRecallQuery(evs);
  check(`last ${RECALL_QUERY_MAX_MESSAGES} messages only`, q.split(' ').length === RECALL_QUERY_MAX_MESSAGES && q.startsWith('msg880') && q.endsWith('msg899'), q.slice(0, 60));
}
{
  const evs = Array.from({ length: 10 }, (_, i) => um(`${i}:` + 'x'.repeat(1000)));
  const q = buildVaultRecallQuery(evs);
  check(`char cap ${RECALL_QUERY_MAX_CHARS}`, q.length <= RECALL_QUERY_MAX_CHARS + 10, String(q.length));
  check('newest message survives the cap', q.endsWith('x'.repeat(50)) && q.includes('9:'));
}
{
  // The real shape of the 2026-09-03 incident: 900 messages, 275k chars.
  const evs = Array.from({ length: 900 }, (_, i) => um(`message number ${i} ` + 'lorem ipsum dolor sit amet '.repeat(11)));
  const q = buildVaultRecallQuery(evs);
  check('incident-shaped input bounded', q.length <= RECALL_QUERY_MAX_CHARS + 10, String(q.length));
}
check('custom limits', buildVaultRecallQuery([um('a'), um('b'), um('c')], { maxMessages: 2 }) === 'b c');
console.log(`${pass} passed, ${fail} failed`); assert.equal(fail, 0);
