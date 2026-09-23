// One chat window per (agent, session) when a layout is restored.
// Run (from web/): npx tsx src/hooks/dedupe-chat-windows.test.mts
import assert from 'node:assert/strict';
import { dedupeChatWindows, sameSession } from './useWindowManager';

const ws = [
  { id: 'a', kind: 'chat', agentName: 'jarvis', sessionId: 'main' },
  { id: 'b', kind: 'chat', agentName: 'jarvis', sessionId: 'projekt' },
  { id: 'c', kind: 'chat', agentName: 'jarvis', sessionId: 'main' }, // twin of a
  { id: 'd', kind: 'chat', agentName: 'hans', sessionId: 'main' }, // other agent: fine
  { id: 'e', kind: 'sessions-list' },
  { id: 'f', kind: 'pin-note', agentName: 'jarvis', sessionId: 'main' }, // not a chat window
];
assert.deepEqual(dedupeChatWindows(ws).map((w) => w.id), ['a', 'b', 'd', 'e', 'f']);
assert.deepEqual(dedupeChatWindows([]), []);
console.log('dedupe-chat-windows: all passed');

// slug and canonical id are the same session
assert.ok(sameSession('main', 'main'));
assert.ok(sameSession('20260923-130655_cockpit-final-0923', 'cockpit-final-0923'));
assert.ok(sameSession('cockpit-final-0923', '20260923-130655_cockpit-final-0923'));
assert.ok(!sameSession('20260923-130655_cockpit-final-0923', 'final-0923'), 'a suffix of the slug is not the slug');
assert.ok(!sameSession('main', undefined));
const mixed = [
  { id: 'a', kind: 'chat', agentName: 'rudi', sessionId: '20260923-130655_cockpit-final-0923' },
  { id: 'b', kind: 'chat', agentName: 'rudi', sessionId: 'cockpit-final-0923' }, // twin by slug
  { id: 'c', kind: 'chat', agentName: 'rudi', sessionId: 'cockpit-run-0923' },
];
assert.deepEqual(dedupeChatWindows(mixed).map((w) => w.id), ['a', 'c']);
console.log('dedupe-chat-windows.test: ok (incl. slug/id)');
