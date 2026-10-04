// Unit tests for the system-inbound notice line the TUI renders for
// synthesized user turns: structured `origin` first, legacy
// `from_system` + regex-over-text as the fallback for old turns.
//
// Run: npx tsx src/cli/tui/turn-origin-notice.test.mts

import assert from 'node:assert/strict';
import { systemNoticeOf } from './turn-views.tsx';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

check('human turn: no notice', () => {
  assert.equal(systemNoticeOf('hello', undefined, undefined), null);
  assert.equal(systemNoticeOf('hello', undefined, { kind: 'human', via: 'chat' }), null);
  assert.equal(systemNoticeOf('hello', undefined, { kind: 'agent', from: { agent: 'x' } }), null);
});

check('tmux: origin wins over text', () => {
  const r = systemNoticeOf("[tmux attention] Session 'old' (…)", 'tmux', {
    kind: 'tmux',
    tmuxSession: 'build-42',
    tmuxKind: 'claude-code',
  });
  assert.deepEqual(r, { label: '🖥  tmux', name: 'build-42' });
});

check('tmux: legacy from_system falls back to regex', () => {
  const r = systemNoticeOf("[tmux attention] Session 'old' (…)", 'tmux', undefined);
  assert.deepEqual(r, { label: '🖥  tmux', name: 'old' });
});

check('browser: origin gives view + cause', () => {
  const r = systemNoticeOf('whatever', undefined, {
    kind: 'browser',
    viewId: 'agent:research',
    cause: 'activity',
  });
  assert.deepEqual(r, { label: '🌐 browser', name: 'research · activity' });
});

check('browser: legacy regex', () => {
  const r = systemNoticeOf("[browser handoff] browser 'agent:research' …", 'browser', undefined);
  assert.deepEqual(r, { label: '🌐 browser', name: 'research · handed back' });
});

check('wake/job: label video, first line without marker', () => {
  const text = '[video] Your render is ready: /tmp/x.mp4\nModel foo, prompt "bar".';
  const withOrigin = systemNoticeOf(text, undefined, { kind: 'wake', about: 'job', ref: 'j1' });
  assert.deepEqual(withOrigin, { label: '🎬 video', name: 'Your render is ready: /tmp/x.mp4' });
  const legacy = systemNoticeOf(text, 'job', undefined);
  assert.deepEqual(legacy, withOrigin);
});

check('wake/subagent: ref from origin, regex fallback', () => {
  const text = "[subagent attention] Task 't-9' (sub-agent 'x', session …";
  assert.deepEqual(systemNoticeOf(text, undefined, { kind: 'wake', about: 'subagent', ref: 't-1' }), {
    label: '🤖 subagent',
    name: 't-1',
  });
  assert.deepEqual(systemNoticeOf(text, 'subagent', undefined), { label: '🤖 subagent', name: 't-9' });
});

check('wake/a2a and voice keep their text-derived names', () => {
  assert.deepEqual(systemNoticeOf('[agent answer] ada has answered …', undefined, { kind: 'wake', about: 'a2a', ref: 'c1' }), {
    label: '↩  agent answer',
    name: 'ada',
  });
  assert.deepEqual(systemNoticeOf('[voice consult] what time is it', 'voice', undefined), {
    label: '🎙  voice',
    name: 'what time is it',
  });
  assert.deepEqual(systemNoticeOf('[voice consult] what time is it', undefined, { kind: 'voice', consultId: 'v1' }), {
    label: '🎙  voice',
    name: 'what time is it',
  });
});

check('sentinel: name from prompt header', () => {
  assert.deepEqual(systemNoticeOf('[Sentinel trigger fired]\nname: nightly\n', undefined, { kind: 'sentinel', triggerId: 't', taskId: 'k' }), {
    label: '🔔 sentinel',
    name: 'nightly',
  });
});

check('system: label and the occasion, from the origin or from the lead-in', () => {
  const text = '[system: restart] The server restart you requested is done: somora 1.0.0, back after 4 s.';
  assert.deepEqual(systemNoticeOf(text, 'system', { kind: 'wake', about: 'system', ref: 'r1', cause: 'restart' }), { label: '⚙  system', name: 'restart' });
  assert.deepEqual(systemNoticeOf(text, 'system', undefined), { label: '⚙  system', name: 'restart' });
  assert.deepEqual(systemNoticeOf('no lead-in', undefined, { kind: 'wake', about: 'system', ref: 'r2' }), { label: '⚙  system', name: '' });
});

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
