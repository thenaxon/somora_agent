// Tests for the tmux attention state machine (attention.ts).
//
// Run: npx tsx src/tmux/attention.test.mts
//
// Focus: the anti-double-trigger contract (design doc §3.2) — a
// completion the origin agent observed itself must NEVER wake it, a
// missed completion must wake it exactly once.

import assert from 'node:assert/strict';
import {
  initialAttentionState,
  stepAttention,
  type AttentionSessionState,
  type AttentionStepInput,
} from './attention.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const ORIGIN = { agent: 'hans', session: 'main' };
const CFG = { wake: true, cooldownS: 60, dailyCapPerSession: 3 };
const T0 = Date.parse('2026-07-27T12:00:00Z');

function step(
  state: AttentionSessionState,
  over: Partial<AttentionStepInput> & { tuiState: AttentionStepInput['tuiState']; now: number },
) {
  return stepAttention({
    state,
    observation: null,
    origin: ORIGIN,
    originBusy: false,
    config: CFG,
    ...over,
  });
}

// ── baseline: no wake salvo over already-idle sessions ────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'ready', now: T0 });
  check('baseline ready fires nothing', r.action.kind === 'none');
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000 });
  check('ready without prior running never fires', r.action.kind === 'none');
  check('no pending accumulated', r.state.pending === null);
}

// ── happy path: running → ready, missed → wake in the SAME tick ──────
// (idle origin, nothing observed, no cooldown: the transition tick
// wakes directly — no artificial extra-tick latency)
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, { tuiState: 'running', now: T0 + 3000 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 6000 });
  check('missed completion wakes on the transition tick', r.action.kind === 'wake');
  check('wake disarms', r.state.disarmed === true);
  check('wake counts', r.state.wakesToday === 1);
  check('needsAttention persists until observed', r.state.needsAttention === true);
  // Ignored wake never repeats.
  r = step(r.state, { tuiState: 'ready', now: T0 + 9000 });
  check('ignored wake is not repeated', r.action.kind === 'none' && r.state.pending === null);
}

// ── anti-double-trigger A: origin observed while its turn ran ─────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  // Origin's wait_idle is blocking inside its turn → busy while the
  // event fires.
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000, originBusy: true });
  check('event fires while origin busy', r.action.kind === 'event');
  // Still busy next tick → defer, no wake.
  r = step(r.state, { tuiState: 'ready', now: T0 + 6000, originBusy: true });
  check('busy origin defers wake', r.action.kind === 'none' && r.state.pending !== null);
  // Turn ended; the agent's wait_idle recorded a ready-observation
  // AFTER the run was last seen running → suppressed, no wake ever.
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 9000,
    observation: {
      lastObservedAt: T0 + 4000,
      agent: 'hans',
      session: 'main',
      sawState: 'ready',
    },
  });
  check('observed completion suppresses wake', r.action.kind === 'observed');
  check('observed clears needsAttention', r.state.needsAttention === false);
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 12_000,
    observation: {
      lastObservedAt: T0 + 4000,
      agent: 'hans',
      session: 'main',
      sawState: 'ready',
    },
  });
  check('nothing fires after observed', r.action.kind === 'none');
}

// ── anti-double-trigger B: same-tick observation beats wake ───────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 3000,
    observation: {
      lastObservedAt: T0 + 3000,
      agent: 'hans',
      session: 'main',
      sawState: 'ready',
    },
  });
  check('same-tick observation suppresses immediately', r.action.kind === 'observed');
}

// ── anti-double-trigger C: watcher detection LAGS the agent's look ────
// The agent's wait_idle saw ready at T+1s; the watcher's transition
// tick is at T+3s. The observation timestamp is BEFORE the watcher's
// eventAt — it must still suppress (sawState-based rule, not eventAt).
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 3000,
    observation: {
      lastObservedAt: T0 + 1000,
      agent: 'hans',
      session: 'main',
      sawState: 'ready',
    },
  });
  check('lagged watcher detection still suppressed', r.action.kind === 'observed', r.action.kind);
}

// ── a mid-run capture (saw running) does NOT suppress ─────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, { tuiState: 'running', now: T0 + 3000 });
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 6000,
    observation: {
      lastObservedAt: T0 + 4000,
      agent: 'hans',
      session: 'main',
      sawState: 'running',
    },
  });
  check('saw-running observation does not suppress the wake', r.action.kind === 'wake', r.action.kind);
}

// ── observation by a DIFFERENT agent does not count ───────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 3000,
    observation: { lastObservedAt: T0 + 3000, agent: 'lisa', session: 'main' },
  });
  check('foreign observation does not stop the wake', r.action.kind === 'wake');
}

// ── disarm/re-arm cycle ───────────────────────────────────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000 }); // wake #1
  check('setup: first wake fired', r.action.kind === 'wake');
  const wakeAt = T0 + 3000;
  // User drives the session manually: running → ready with NO origin
  // interaction → disarmed, no new event.
  r = step(r.state, { tuiState: 'running', now: T0 + 9000 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 12_000 });
  check('disarmed session fires no event on user-driven cycle', r.action.kind === 'none');
  // Origin comes back (observation after the wake) → re-armed; the
  // next completion (cooldown long passed) wakes again.
  r = step(r.state, {
    tuiState: 'running',
    now: T0 + 100_000,
    observation: { lastObservedAt: wakeAt + 1000, agent: 'hans', session: 'main' },
  });
  check('origin interaction re-arms', r.state.disarmed === false);
  r = step(r.state, {
    tuiState: 'ready',
    now: T0 + 103_000,
    observation: { lastObservedAt: wakeAt + 1000, agent: 'hans', session: 'main' },
  });
  check('re-armed session wakes again', r.action.kind === 'wake', r.action.kind);
}

// ── cooldown ──────────────────────────────────────────────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 6000 }); // wake #1
  // Re-arm + new cycle within the 60s cooldown.
  const obs = { lastObservedAt: T0 + 7000, agent: 'hans', session: 'main' };
  r = step(r.state, { tuiState: 'running', now: T0 + 10_000, observation: obs });
  r = step(r.state, { tuiState: 'ready', now: T0 + 13_000, observation: obs });
  check('event inside cooldown', r.action.kind === 'event');
  r = step(r.state, { tuiState: 'ready', now: T0 + 16_000, observation: obs });
  check('wake deferred during cooldown', r.action.kind === 'none' && r.state.pending !== null);
  r = step(r.state, { tuiState: 'ready', now: T0 + 70_000, observation: obs });
  check('wake fires after cooldown', r.action.kind === 'wake');
}

// ── daily cap ─────────────────────────────────────────────────────────
{
  let s = initialAttentionState();
  let now = T0;
  const obsBase = { agent: 'hans', session: 'main' };
  const transitionActions: string[] = [];
  for (let i = 0; i < 4; i++) {
    let r = step(s, {
      tuiState: 'running',
      now: (now += 61_000),
      observation: { lastObservedAt: now - 500, ...obsBase },
    });
    s = r.state;
    r = step(s, { tuiState: 'ready', now: (now += 61_000) });
    s = r.state;
    transitionActions.push(r.action.kind);
  }
  check(
    'cap: 3 wakes then cap_reached (cap=3)',
    transitionActions.join(',') === 'wake,wake,wake,cap_reached',
    transitionActions.join(','),
  );
  check('cap keeps the flag', s.needsAttention === true);
  check('cap consumed no 4th wake', s.wakesToday === 3);
  // Next UTC day resets the counter.
  const nextDay = now + 24 * 3600 * 1000;
  let r = step(s, {
    tuiState: 'running',
    now: nextDay,
    observation: { lastObservedAt: now - 500, ...obsBase },
  });
  r = step(r.state, { tuiState: 'ready', now: nextDay + 3000 });
  check('day rollover resets the cap', r.action.kind === 'wake', r.action.kind);
}

// ── wake:false = events only ──────────────────────────────────────────
{
  const cfg = { ...CFG, wake: false };
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0, config: cfg });
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000, config: cfg });
  check('wake:false still fires event', r.action.kind === 'event');
  r = step(r.state, { tuiState: 'ready', now: T0 + 6000, config: cfg });
  check('wake:false never wakes', r.action.kind === 'none');
  check('wake:false keeps the flag', r.state.needsAttention === true && r.state.pending === null);
}

// ── a new run clears a stale pending (moment passed) ──────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'running', now: T0 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000, originBusy: true }); // event, deferred
  r = step(r.state, { tuiState: 'running', now: T0 + 6000, originBusy: true });
  check('new running clears pending', r.state.pending === null);
  r = step(r.state, { tuiState: 'ready', now: T0 + 9000 });
  check('next completion re-fires (wakes)', r.action.kind === 'wake', r.action.kind);
}

// ── queued counts as running ──────────────────────────────────────────
{
  let r = step(initialAttentionState(), { tuiState: 'queued', now: T0 });
  r = step(r.state, { tuiState: 'ready', now: T0 + 3000, originBusy: true });
  check('queued→ready fires event (queued = mid-cycle)', r.action.kind === 'event');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
