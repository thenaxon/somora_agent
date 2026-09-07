// Tests for the A2A attribution header (a2a.ts).
//
// Run: npx tsx src/engine/a2a.test.mts

import assert from 'node:assert/strict';
import { sessionSlugOf, withFromAgentHeader } from './a2a.ts';

assert.equal(sessionSlugOf('main'), 'main');
assert.equal(sessionSlugOf('20260906-172957_cerebrocraft'), 'cerebrocraft');
assert.equal(sessionSlugOf('sub-hans-123-ab12'), 'sub-hans-123-ab12');

assert.equal(withFromAgentHeader('hi', undefined), 'hi');
assert.equal(withFromAgentHeader('hi', undefined, 'main'), 'hi');
assert.equal(withFromAgentHeader('hi', 'hans'), '[Message from agent hans]\nhi');
assert.equal(
  withFromAgentHeader('hi', 'hans', '20260906-172957_cerebrocraft'),
  '[Message from agent hans, session cerebrocraft]\nhi',
);
assert.equal(withFromAgentHeader('hi', 'hans', 'main'), '[Message from agent hans, session main]\nhi');

console.log('a2a header: all assertions passed');
