// One chat window per (agent, session) when a layout is restored.
// Run (from web/): npx tsx src/hooks/dedupe-chat-windows.test.mts
import assert from 'node:assert/strict';
import { dedupeChatWindows } from './useWindowManager';

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
