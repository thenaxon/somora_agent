// Run: npx tsx web/src/lib/question.test.mts
//
// A question that does not wait, as the web and phone cards read it:
// its parts, whether one click answers it, and the answer body.
import assert from 'node:assert/strict';
import { answersOnClick, buildAnswer, questionParts } from './question';
import type { SessionQuestion } from './api';

const one: SessionQuestion = { id: 'q', question: 'Go on?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false, expiresAt: 0, async: true };

assert.deepEqual(questionParts(one), [{ question: 'Go on?', options: one.options, multiple: false }]);
assert.equal(answersOnClick(one), true, 'one question, one answer: a click sends it');
assert.equal(answersOnClick({ ...one, multiple: true }), false, 'several answers: pick, then send');
assert.equal(answersOnClick({ ...one, options: [] }), false, 'no options: own words');

assert.equal(buildAnswer(one, [[]], ['']), null, 'nothing chosen, nothing typed');
assert.deepEqual(buildAnswer(one, [['Yes']], ['']), { answers: ['Yes'] });
assert.deepEqual(buildAnswer({ ...one, options: [] }, [[]], ['  Kai ']), { text: 'Kai' });

const two: SessionQuestion = {
  ...one,
  parts: [
    { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }], multiple: false },
    { question: 'Name?', options: [], multiple: false },
  ],
};
assert.equal(questionParts(two).length, 2);
assert.equal(answersOnClick(two), false, 'several questions: Send');
assert.deepEqual(buildAnswer(two, [['Red'], []], ['', 'Kai']), { parts: [{ answers: ['Red'] }, { text: 'Kai' }] });
assert.deepEqual(buildAnswer(two, [[], []], ['', 'Kai']), { parts: [{}, { text: 'Kai' }] }, 'one part answered is enough');
assert.equal(buildAnswer(two, [[], []], ['', '']), null);

console.log('question: ok');
