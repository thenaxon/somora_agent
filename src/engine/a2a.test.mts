// Tests for the A2A attribution header (a2a.ts).
//
// Run: npx tsx src/engine/a2a.test.mts

import assert from 'node:assert/strict';
import { sessionSlugOf, withFromAgentHeader } from './a2a.ts';

assert.equal(sessionSlugOf('main'), 'main');
assert.equal(sessionSlugOf('20260906-172957_craftbox'), 'craftbox');
assert.equal(sessionSlugOf('sub-ada-123-ab12'), 'sub-ada-123-ab12');

assert.equal(withFromAgentHeader('hi', undefined), 'hi');
assert.equal(withFromAgentHeader('hi', undefined, 'main'), 'hi');
assert.equal(withFromAgentHeader('hi', 'ada'), '[Message from agent ada]\nhi');
assert.equal(
  withFromAgentHeader('hi', 'ada', '20260906-172957_craftbox'),
  '[Message from agent ada, session craftbox]\nhi',
);
assert.equal(withFromAgentHeader('hi', 'ada', 'main'), '[Message from agent ada, session main]\nhi');

console.log('a2a header: all assertions passed');
