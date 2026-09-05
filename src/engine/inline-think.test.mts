// Run: npx tsx src/engine/inline-think.test.mts
import assert from 'node:assert/strict';
import { insideOpenThink, splitInlineThink } from './inline-think.ts';

// Plain inline block
assert.deepEqual(splitInlineThink('<think>step one\nstep two</think>\n\nAnswer.'), {
  thinking: 'step one\nstep two',
  content: 'Answer.',
});
// DeepSeek-on-SGLang shape: opening tag lives in the prompt template
assert.deepEqual(splitInlineThink('\n\n\n\nI will fetch all 18 dreams…</think>| a | b |'), {
  thinking: 'I will fetch all 18 dreams…',
  content: '| a | b |',
});
// No block → untouched
assert.deepEqual(splitInlineThink('Just an answer'), { thinking: '', content: 'Just an answer' });
// Closing tag deep inside real content with an opening tag mid-text → untouched
const prose = 'The tags are <think> and </think>, use them like this.';
assert.deepEqual(splitInlineThink(prose), { thinking: '', content: prose });
// Empty reasoning block
assert.deepEqual(splitInlineThink('<think></think>hi'), { thinking: '', content: 'hi' });
// Streaming helper
assert.equal(insideOpenThink('<think>partial reas'), true);
assert.equal(insideOpenThink('<think>done</think>ans'), false);
assert.equal(insideOpenThink('plain'), false);
console.log('inline-think: all tests passed');
