// Run: npx tsx web/src/lib/origin.test.mts
//
// The presentation table for system-originated inbounds: structured
// `origin` first, legacy `from_system` + text regexes for turns
// recorded before 2026-09-13, and bubbles (null) for people, peer
// agents and a sub-agent's own brief.
import assert from 'node:assert/strict';
import { originPresentation } from './origin';

// --- bubbles, not dividers ------------------------------------------
assert.equal(originPresentation({ text: 'hi', origin: { kind: 'human', via: 'chat' } }), null);
assert.equal(originPresentation({ text: 'hi', origin: { kind: 'human', via: 'voice-stt' } }), null);
assert.equal(
  originPresentation({ text: 'hi', origin: { kind: 'agent', from: { agent: 'x' } }, fromAgent: 'x' }),
  null,
);
assert.equal(originPresentation({ text: 'brief', origin: { kind: 'subagent', depth: 1 } }), null);
assert.equal(originPresentation({ text: 'hi' }), null);
assert.equal(originPresentation({ text: 'hi', fromAgent: 'x' }), null);
// A peer message never becomes a divider, whatever from_system says.
assert.equal(originPresentation({ text: 'hi', fromAgent: 'x', fromSystem: 'a2a' }), null);

// --- sentinel ---------------------------------------------------------
const sentinelText = '[Sentinel trigger fired]\ntrigger_id: trg_1\nname: nightly digest\nwhen: …';
{
  const p = originPresentation({
    text: sentinelText,
    origin: { kind: 'sentinel', triggerId: 'trg_1', taskId: 'task_1' },
  });
  assert.equal(p?.kind, 'sentinel');
  assert.equal(p?.subtitle, 'nightly digest');
  assert.equal(p?.detail, 'trg_1');
  assert.equal(p?.body.startsWith('trigger_id: trg_1'), true);
}
{
  const p = originPresentation({ text: sentinelText, fromSystem: 'sentinel' });
  assert.equal(p?.kind, 'sentinel');
  assert.equal(p?.subtitle, 'nightly digest');
  assert.equal(p?.detail, undefined);
}

// --- tmux -------------------------------------------------------------
const tmuxText = "[tmux attention] Session 'build-42' (claude) became ready — …";
{
  const p = originPresentation({
    text: tmuxText,
    origin: { kind: 'tmux', tmuxSession: 'build-42', tmuxKind: 'claude' },
  });
  assert.equal(p?.kind, 'tmux');
  assert.equal(p?.subtitle, 'build-42 · claude');
}
assert.equal(
  originPresentation({ text: tmuxText, origin: { kind: 'tmux', tmuxSession: 'build-42' } })?.subtitle,
  'build-42',
);
assert.equal(originPresentation({ text: tmuxText, fromSystem: 'tmux' })?.subtitle, 'build-42');

// --- browser ----------------------------------------------------------
const handoffText = "[browser] The user handed browser 'agent:naxon' back to you (handoff h1). …";
const activityText = "[browser] The user took over browser 'agent:naxon', did something there …";
{
  const p = originPresentation({
    text: handoffText,
    origin: { kind: 'browser', viewId: 'agent:naxon', cause: 'handoff', handoffId: 'h1' },
  });
  assert.equal(p?.kind, 'browser');
  assert.equal(p?.subtitle, 'naxon · handed back');
}
assert.equal(
  originPresentation({
    text: activityText,
    origin: { kind: 'browser', viewId: 'profile:work', cause: 'activity' },
  })?.subtitle,
  'profile work · activity',
);
assert.equal(
  originPresentation({ text: handoffText, fromSystem: 'browser' })?.subtitle,
  'naxon · handed back',
);
assert.equal(
  originPresentation({ text: activityText, fromSystem: 'browser' })?.subtitle,
  'naxon · handed back after your changes',
);

// --- voice ------------------------------------------------------------
const long = 'x'.repeat(120);
{
  const p = originPresentation({
    text: `[voice consult] ${long}`,
    origin: { kind: 'voice', consultId: 'c1' },
  });
  assert.equal(p?.kind, 'voice');
  assert.equal(p?.body, long);
  assert.equal(p?.subtitle, `${'x'.repeat(80)}…`);
  assert.equal(p?.detail, 'c1');
}
assert.equal(originPresentation({ text: '[voice] short', fromSystem: 'voice' })?.subtitle, 'short');

// --- wake: a2a / subagent / job -------------------------------------
const answerText = '[agent answer] hans has answered the question you sent to session main …';
{
  const p = originPresentation({
    text: answerText,
    origin: { kind: 'wake', about: 'a2a', ref: 'call_9' },
  });
  assert.equal(p?.kind, 'a2a');
  assert.equal(p?.label, 'agent answer');
  assert.equal(p?.subtitle, 'hans');
  assert.equal(p?.detail, 'call_9');
}
assert.equal(originPresentation({ text: answerText, fromSystem: 'a2a' })?.subtitle, 'hans');

const subText = "[subagent attention] Task 'task_7' (sub-agent 'hans', session …) finished";
{
  const p = originPresentation({
    text: subText,
    origin: { kind: 'wake', about: 'subagent', ref: 'task_7', depth: 1 },
  });
  assert.equal(p?.kind, 'subagent');
  assert.equal(p?.subtitle, 'task_7');
}
assert.equal(originPresentation({ text: subText, fromSystem: 'subagent' })?.subtitle, 'task_7');

const videoText = '[video] Your render is ready: /tmp/a.mp4\nModel veo, prompt "…".\nThe user already sees it.';
{
  const p = originPresentation({
    text: videoText,
    origin: { kind: 'wake', about: 'job', ref: 'job_3' },
  });
  assert.equal(p?.kind, 'job');
  assert.equal(p?.label, 'video');
  assert.equal(p?.subtitle, 'Your render is ready: /tmp/a.mp4');
  assert.equal(p?.detail, 'job_3');
}
assert.equal(
  originPresentation({ text: videoText, fromSystem: 'job' })?.subtitle,
  'Your render is ready: /tmp/a.mp4',
);

// Every legacy word maps to a row.
for (const fs of ['sentinel', 'tmux', 'subagent', 'job', 'browser', 'voice', 'a2a'] as const) {
  assert.notEqual(originPresentation({ text: '', fromSystem: fs }), null, fs);
}

console.log('origin.test: all assertions passed');
