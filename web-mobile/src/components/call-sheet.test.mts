// The call screen on the phone, rendered.
//
// Run: cd web-mobile && npx tsx --test src/components/call-sheet.test.mts
//
// No effects run in renderToString: what is checked is what the screen
// shows for each state of a call it is handed — the audio itself is the
// shared hook's, tested with the web client's voice window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { VoiceCall } from '../../../web/src/hooks/useVoiceCall';

// The shared web components resolve React from web/node_modules; the app
// build dedupes it (vite resolve.dedupe), node does not. The same here:
// React imported from web/src is resolved from this package.
const here = new URL('./', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (/^react(-dom)?(\\/|$)/.test(specifier) && context.parentURL && context.parentURL.includes('/web/src/')) {
          return next(specifier, { ...context, parentURL: ${JSON.stringify(here)} });
        }
        return next(specifier, context);
      }`),
);
// and a shared component compiled from outside this package's tsconfig
// gets the classic JSX transform, which wants a global React
(globalThis as { React?: unknown }).React = React;
const { CallSheet } = await import('./CallSheet');

function fakeCall(over: Partial<VoiceCall>): VoiceCall {
  return {
    state: 'idle',
    error: null,
    muted: false,
    transcript: [],
    partial: null,
    consults: 0,
    handoverTo: null,
    identity: { agent: 'ada', session: 'main' },
    elapsed: 0,
    live: false,
    connect: async () => undefined,
    hangUp: () => undefined,
    toggleMute: () => undefined,
    micLevel: () => 0,
    agentLevel: () => 0,
    ...over,
  };
}

function render(call: VoiceCall): string {
  return renderToString(
    React.createElement(CallSheet, {
      call,
      agent: 'ada',
      session: 'main',
      agents: [{ name: 'ada', color: '#6cf', icon: '🔧' }, { name: 'bea', color: '#f6c' }],
      maxCallMinutes: 20,
      onClose: () => undefined,
    }),
  );
}

test('while calling, the screen says so and offers mute and hang up', () => {
  const html = render(fakeCall({ state: 'connecting' }));
  assert.ok(html.includes('calling…'));
  assert.ok(html.includes('call-mute') && html.includes('call-hangup'));
  assert.ok(!html.includes('call-again'));
});

test('a live call shows who is talking, the clock and what was said', () => {
  const html = render(
    fakeCall({
      state: 'speaking',
      live: true,
      elapsed: 75,
      transcript: [{ who: 'you', text: 'Wie spät ist es?' }],
      partial: { who: 'agent', text: 'Es ist halb' },
    }),
  );
  assert.ok(html.includes('ada is talking'));
  assert.ok(html.includes('1:15'));
  assert.ok(html.includes('Wie spät ist es?') && html.includes('Es ist halb'));
});

test('a move to another agent shows the new agent', () => {
  const html = render(fakeCall({ state: 'listening', live: true, identity: { agent: 'bea', session: 'craftbox' } }));
  assert.ok(html.includes('bea') && html.includes('craftbox'));
  assert.ok(html.includes('call with bea'));
});

test('muted says so on the button and in the caption', () => {
  const html = render(fakeCall({ state: 'listening', live: true, muted: true }));
  assert.ok(html.includes('unmute'));
  assert.ok(html.includes('>muted<'));
});

test('an ended call offers to call again or close, and names an error', () => {
  const html = render(fakeCall({ state: 'closed', error: 'connection failed' }));
  assert.ok(html.includes('call ended'));
  assert.ok(html.includes('call-again') && html.includes('call-close'));
  assert.ok(html.includes('connection failed'));
  assert.ok(!html.includes('call-hangup'));
});
