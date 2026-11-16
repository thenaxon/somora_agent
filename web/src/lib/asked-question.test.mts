// An agent's ask_user call as a conversation row (2026-11-14 report):
// read from the history's input and from the live event's JSON details.
// Run: cd web && npx tsx src/lib/asked-question.test.mts
import assert from 'node:assert/strict';
import { askedQuestionFrom, isAskUserTool } from './asked-question';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};

const input = { question: 'Post this?', header: 'LinkedIn', details: '> Draft text', options: [{ label: 'Post' }, { label: 'Not yet', description: 'keep the draft' }], multiple: false };

t('both names of the tool', () => {
  assert.ok(isAskUserTool('ask_user'));
  assert.ok(isAskUserTool('mcp__somora__ask_user'));
  assert.ok(!isAskUserTool('ask_user_result'));
  assert.ok(!isAskUserTool('exec'));
});
t('from the history input', () => {
  const a = askedQuestionFrom({ tool: 'mcp__somora__ask_user', input });
  assert.deepEqual(a, { question: 'Post this?', header: 'LinkedIn', details: '> Draft text', options: [{ label: 'Post' }, { label: 'Not yet', description: 'keep the draft' }], multiple: false });
});
t('from the live details', () => {
  const a = askedQuestionFrom({ tool: 'ask_user', details: JSON.stringify(input, null, 2) });
  assert.equal(a?.question, 'Post this?');
  assert.equal(a?.details, '> Draft text');
});
t('another tool, broken details or no question: no row', () => {
  assert.equal(askedQuestionFrom({ tool: 'exec', input }), null);
  assert.equal(askedQuestionFrom({ tool: 'ask_user', details: '{"question": "cut off' }), null);
  assert.equal(askedQuestionFrom({ tool: 'ask_user', input: { options: [] } }), null);
});

console.log(`\nasked-question: ${ok} passed, ${bad} failed`);
assert.equal(bad, 0);
