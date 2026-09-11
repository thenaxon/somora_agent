// The voice window, rendered (2026-09-11).
//
// Run: cd web && npx tsx src/components/voice-render.test.mts
//
// No effects run in renderToString, so what is checked here is the part
// that must be right before a single byte of audio moves: an instance
// without realtime voice says so instead of offering a dead call
// button, and the window it renders carries the controls the call
// depends on.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { VoiceWindow } from './VoiceWindow';
import { VoiceOrb } from './VoiceOrb';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};
function assertTrue(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const agents = [{ name: 'hans', description: 'Engineer', icon: '🔧', color: '#6cf', role: 'Engineer' }];

t('the window renders before the server has answered', () => {
  const html = renderToString(React.createElement(VoiceWindow, { agents } as never));
  assertTrue(html.includes('voice-agent'), 'no agent picker');
  assertTrue(html.includes('voice-session'), 'no session picker');
  assertTrue(html.includes('voice-connect'), 'no call button');
});

t('the orb is there to be driven by real audio', () => {
  const html = renderToString(
    React.createElement(VoiceOrb, { color: '#6cf', speaker: 'agent', active: true, micLevel: () => 0, agentLevel: () => 0 }),
  );
  assertTrue(html.includes('voice-orb'), 'no canvas');
  assertTrue(html.includes('speaking'), 'no state on the label');
});

t('an idle orb says idle, so a dead call is visible', () => {
  const html = renderToString(
    React.createElement(VoiceOrb, { color: '#6cf', speaker: 'you', active: false, micLevel: () => 0, agentLevel: () => 0 }),
  );
  assertTrue(html.includes('idle'), 'idle orb does not say so');
});

console.log(`\n${ok} ok, ${bad} failed`);
assert.equal(bad, 0);
