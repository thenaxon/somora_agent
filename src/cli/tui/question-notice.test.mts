// The question line in the TUI: a waiting question says the agent waits;
// one that does not wait says to answer any time — by number or in your
// own words — and several questions at once are listed one by one.
//
// Run: npx tsx src/cli/tui/question-notice.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionNotice } from './app.tsx';
import type { SessionQuestion } from './types.ts';

const q: SessionQuestion = { id: 'q', question: 'Go on?', options: [{ label: 'Yes' }, { label: 'No' }], expiresAt: 0 };

test('a waiting question', () => {
  assert.equal(questionNotice('ada', { ...q, expiresAt: 1 }), '❓ Go on?\n   1 Yes\n   2 No\n   type the number (ada waits)');
});

test('a question that does not wait', () => {
  assert.equal(questionNotice('ada', { ...q, async: true }), '❓ Go on?\n   1 Yes\n   2 No\n   type the number or write your own answer (ada asks; answer any time)');
  assert.equal(questionNotice('ada', { ...q, async: true, options: [] }), '❓ Go on?\n   answer in your own words (ada asks; answer any time)');
});

test('several questions at once', () => {
  const two: SessionQuestion = {
    ...q,
    async: true,
    parts: [
      { question: 'Colour?', options: [{ label: 'Red' }] },
      { question: 'Name?', options: [] },
    ],
  };
  assert.equal(questionNotice('ada', two), '❓ Colour?\n   1 Red\n❓ Name?\n   answer in your own words (ada asks; answer any time)');
});
