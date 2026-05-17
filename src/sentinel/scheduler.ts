// Sentinel scheduler — the long-running loop that watches the trigger
// registry and fires triggers at their nextFireAt.
//
// Architecture choice: in-process, setTimeout-based, single global
// timer that re-arms after each fire. Inspired by the dream-scheduler
// (which uses the same "compute next, sleep until then, fire, repeat"
// pattern) but independent — coupling would tangle two unrelated
// timing concerns.
//
// Recovery on boot
//   When somora starts, loadTriggers() rehydrates the registry. Then
//   scheduleNext() walks all active triggers, computes their next-fire
//   from the SPEC (not stored nextFireAt — that may be stale across a
//   restart), and applies catch-up policy:
//     - one-shot 'at' triggers whose moment has passed within
//       CATCHUP_GRACE_MS → fire once with catchUp:true, then mark
//       completed.
//     - one-shot 'at' triggers whose moment has passed beyond grace
//       → mark completed without firing (we missed it, don't pretend).
//     - recurring triggers whose last expected fire was missed → don't
//       backfill, just schedule the next future fire. The agent should
//       not get six "you have new mail" pings because somora was down
//       for a day.
//
// Concurrency: when a fire kicks off, the next-fire computation runs
// AFTER the fire returns (success or error). For 'every'-style
// recurring triggers we use the previous fire's timestamp + interval
// as the anchor, so a slow agent-turn doesn't cause drift across
// later fires.

import { logger } from '../server/logger.ts';
import { acquireSessionLock } from '../server/session-queue.ts';
import { runChatTurn } from '../server/run-turn.ts';
import { newTaskId, registerTask, completeTask, failTask } from '../server/async-tasks.ts';
import { resolveSessionId, createSession } from '../storage/sessions.ts';
import { loadPersona } from '../persona/loader.ts';
import { reserveSpawnSlot, releaseSpawnSlot } from '../tools/agents/spawn.ts';
import { computeNextFire } from './schedule.ts';
import { buildFirePrompt } from './dispatcher.ts';
import {
  countFiresToday,
  getTrigger,
  listTriggers,
  loadTriggers,
  recordFire,
  saveTrigger,
} from './store.ts';
import {
  SENTINEL_LIMITS,
  type Trigger,
} from './types.ts';

// chatTurnDeps is owned by the server boot path and injected here so
// sentinel can run an agent-turn without a network round-trip.
// Same pattern as configureSpawnTools({ chatTurnDeps }).
type ChatTurnDeps = Parameters<typeof runChatTurn>[0]['deps'];
let injectedChatTurnDeps: ChatTurnDeps | null = null;

export function configureSentinel(args: { chatTurnDeps: ChatTurnDeps }): void {
  injectedChatTurnDeps = args.chatTurnDeps;
}

let started = false;
let nextTimer: NodeJS.Timeout | null = null;
let nextFireAt: number | null = null;

/** Compute the next fire instant across ALL active triggers + a Trigger
 *  pointer. Returns null when no triggers are armed. */
function pickNextDue(now: number = Date.now()): { trigger: Trigger; fireAt: number } | null {
  let pick: { trigger: Trigger; fireAt: number } | null = null;
  for (const t of listTriggers()) {
    if (t.status !== 'active') continue;
    if (!t.nextFireAt) continue;
    const fireAt = new Date(t.nextFireAt).getTime();
    if (Number.isNaN(fireAt)) continue;
    if (!pick || fireAt < pick.fireAt) {
      pick = { trigger: t, fireAt };
    }
  }
  void now;
  return pick;
}

/** Re-arm the global timer. Always call after any state change
 *  (trigger create/pause/resume/delete/fire). Idempotent. */
export function reschedule(): void {
  if (!started) return;
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
    nextFireAt = null;
  }
  const pick = pickNextDue();
  if (!pick) {
    logger.info({ msg: 'sentinel.scheduler.idle', reason: 'no active triggers with future fire' });
    return;
  }
  const delay = Math.max(0, pick.fireAt - Date.now());
  // Node 20 setTimeout caps at ~24.8 days. For longer-out 'at' triggers
  // we re-arm on the cap and re-evaluate; the next reschedule() call
  // (from any state change or this scheduled re-arm) picks up correctly.
  const safeDelay = Math.min(delay, 24 * 60 * 60 * 1000); // re-evaluate at least daily
  nextFireAt = Date.now() + safeDelay;
  nextTimer = setTimeout(() => {
    nextTimer = null;
    nextFireAt = null;
    void onTimer();
  }, safeDelay);
  logger.info({
    msg: 'sentinel.scheduler.armed',
    triggerId: pick.trigger.id,
    fireAt: new Date(pick.fireAt).toISOString(),
    delayMs: delay,
    armedMs: safeDelay,
  });
}

async function onTimer(): Promise<void> {
  // Re-pick at fire time — registry may have changed during sleep,
  // and we want the actually-due trigger (not a stale memory of which
  // was due when we armed).
  const pick = pickNextDue();
  if (!pick) {
    reschedule();
    return;
  }
  if (pick.fireAt > Date.now() + 1000) {
    // We woke up early (probably re-arm cap). Re-schedule.
    reschedule();
    return;
  }
  await fireTrigger(pick.trigger, { catchUp: false, testMode: false });
  reschedule();
}

interface FireOptions {
  catchUp: boolean;
  testMode: boolean;
}

/** Fire a trigger NOW. Used by the scheduled timer, by boot catch-up,
 *  and by `test-now` (which bypasses cooldown and daily-cap checks). */
export async function fireTrigger(
  trigger: Trigger,
  opts: FireOptions = { catchUp: false, testMode: false },
): Promise<void> {
  const now = new Date();
  const scheduledFor = trigger.nextFireAt ?? now.toISOString();

  // Cooldown check (skipped in test mode)
  if (!opts.testMode && trigger.policy?.cooldownMs && trigger.lastSuccessAt) {
    const sinceLast = now.getTime() - new Date(trigger.lastSuccessAt).getTime();
    if (sinceLast < trigger.policy.cooldownMs) {
      await recordFire(trigger.id, {
        firedAt: now.toISOString(),
        scheduledFor,
        outcome: 'skipped',
        skipReason: `cooldown (${Math.round((trigger.policy.cooldownMs - sinceLast) / 1000)}s remaining)`,
        ...(opts.catchUp ? { catchUp: true } : {}),
      });
      await advanceNextFire(trigger);
      return;
    }
  }

  // Daily-cap check (skipped in test mode)
  if (!opts.testMode) {
    const todayCount = await countFiresToday(trigger.id);
    if (todayCount >= (trigger.policy?.maxFiresPerDay ?? SENTINEL_LIMITS.MAX_FIRES_PER_DAY)) {
      await recordFire(trigger.id, {
        firedAt: now.toISOString(),
        scheduledFor,
        outcome: 'skipped',
        skipReason: `daily_cap (${todayCount} fires today)`,
        ...(opts.catchUp ? { catchUp: true } : {}),
      });
      // Auto-pause until tomorrow
      const updated: Trigger = {
        ...trigger,
        status: 'paused',
        statusReason: `auto-paused: daily cap (${todayCount}) reached`,
      };
      await saveTrigger(updated);
      return;
    }
  }

  // ── Actually fire: route through the in-process /spawn-async core ──
  const dispatch = trigger.dispatch;

  // Make sure the agent exists; never silently swallow this.
  if (!(await loadPersona(dispatch.agent))) {
    await markError(trigger, `agent '${dispatch.agent}' nicht gefunden`, scheduledFor, now, opts.catchUp);
    return;
  }

  // Resolve session — auto-create with timestamp prefix if not existing,
  // mirroring the Phase 0 /spawn-async fix. Sentinel-managed sessions
  // are recurring entry-points so the slug naming is intentional.
  let session: string;
  try {
    let resolved = await resolveSessionId(dispatch.agent, dispatch.session);
    if (!resolved) {
      const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(dispatch.session);
      if (isExactId) throw new Error(`session '${dispatch.session}' nicht gefunden`);
      if (dispatch.session === 'main') resolved = 'main';
      else resolved = await createSession(dispatch.agent, dispatch.session);
    }
    session = resolved;
  } catch (err) {
    await markError(trigger, `session resolution failed: ${(err as Error).message}`, scheduledFor, now, opts.catchUp);
    return;
  }

  // Concurrency cap (same as /spawn-async)
  const slotErr = reserveSpawnSlot(dispatch.agent);
  if (slotErr) {
    await recordFire(trigger.id, {
      firedAt: now.toISOString(),
      scheduledFor,
      outcome: 'skipped',
      skipReason: `concurrency: ${slotErr}`,
      ...(opts.catchUp ? { catchUp: true } : {}),
      ...(opts.testMode ? { testMode: true } : {}),
    });
    await advanceNextFire(trigger);
    return;
  }

  const taskId = newTaskId();
  registerTask({
    task_id: taskId,
    parent_agent: 'sentinel',
    parent_session: trigger.id,
    target_agent: dispatch.agent,
    target_session: session,
    started_at: Date.now(),
  });

  const prompt = buildFirePrompt(trigger, now, opts.catchUp);

  // Fire-and-forget. Lock acquisition matches /spawn-async semantics.
  if (!injectedChatTurnDeps) {
    // Defensive — should never happen if configureSentinel ran at
    // server boot. If it does, log loudly and skip rather than crash.
    logger.error({
      msg: 'sentinel.scheduler.no_deps',
      triggerId: trigger.id,
      hint: 'configureSentinel({chatTurnDeps}) was not called at boot',
    });
    releaseSpawnSlot(dispatch.agent);
    await markError(trigger, 'sentinel not initialized (no chatTurnDeps)', scheduledFor, now, opts.catchUp, taskId, opts.testMode);
    return;
  }

  const deps = injectedChatTurnDeps;
  void (async () => {
    const release = await acquireSessionLock(dispatch.agent, session, {
      priority: 'agent',
      turnId: taskId,
    });
    try {
      const result = await runChatTurn({
        agent: dispatch.agent,
        session,
        text: prompt,
        turnId: taskId,
        deps,
      });
      completeTask(taskId, result);
      const fresh = getTrigger(trigger.id);
      if (fresh) {
        const updated: Trigger = {
          ...fresh,
          fireCount: fresh.fireCount + 1,
          lastFireAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          errorStreak: 0,
        };
        await saveTrigger(updated);
        await recordFire(trigger.id, {
          firedAt: now.toISOString(),
          scheduledFor,
          outcome: 'success',
          taskId,
          ...(opts.catchUp ? { catchUp: true } : {}),
          ...(opts.testMode ? { testMode: true } : {}),
        });
        await advanceNextFire(updated);
      }
    } catch (err) {
      failTask(taskId, (err as Error).message);
      await markError(
        getTrigger(trigger.id) ?? trigger,
        (err as Error).message,
        scheduledFor,
        now,
        opts.catchUp,
        taskId,
        opts.testMode,
      );
    } finally {
      release();
      releaseSpawnSlot(dispatch.agent);
    }
  })();
}

async function markError(
  trigger: Trigger,
  errorMsg: string,
  scheduledFor: string,
  now: Date,
  catchUp: boolean,
  taskId?: string,
  testMode?: boolean,
): Promise<void> {
  await recordFire(trigger.id, {
    firedAt: now.toISOString(),
    scheduledFor,
    outcome: 'error',
    error: errorMsg,
    ...(taskId ? { taskId } : {}),
    ...(catchUp ? { catchUp: true } : {}),
    ...(testMode ? { testMode: true } : {}),
  });
  const fresh = getTrigger(trigger.id) ?? trigger;
  const newStreak = (fresh.errorStreak ?? 0) + 1;
  const updated: Trigger = {
    ...fresh,
    fireCount: fresh.fireCount + 1,
    lastFireAt: now.toISOString(),
    lastErrorAt: now.toISOString(),
    errorStreak: newStreak,
  };
  if (newStreak >= SENTINEL_LIMITS.ERROR_STREAK_THRESHOLD) {
    updated.status = 'error';
    updated.statusReason = `auto-paused: ${newStreak} consecutive errors. Last: ${errorMsg.slice(0, 200)}`;
    logger.warn({
      msg: 'sentinel.scheduler.trigger_auto_paused',
      triggerId: trigger.id,
      streak: newStreak,
      error: errorMsg,
    });
  }
  await saveTrigger(updated);
  await advanceNextFire(updated);
}

/** Compute and persist nextFireAt after a fire/skip/error. For 'at'
 *  triggers whose moment is past, mark `completed`. */
async function advanceNextFire(trigger: Trigger): Promise<void> {
  if (trigger.status !== 'active') {
    // Don't compute next-fire for paused/error/completed — they don't
    // re-arm until status flips back to 'active'.
    return;
  }
  if (trigger.source.type !== 'time') return; // Phase 2+ sources handled differently
  const next = computeNextFire(trigger.source.spec);
  if (next === null) {
    // 'at' trigger one-shot completed.
    const updated: Trigger = {
      ...trigger,
      status: 'completed',
      statusReason: 'one-shot fired',
    };
    delete updated.nextFireAt;
    await saveTrigger(updated);
    return;
  }
  const updated: Trigger = { ...trigger, nextFireAt: next.toISOString() };
  await saveTrigger(updated);
}

/** Apply catch-up policy to a freshly-loaded trigger at boot. */
async function applyBootCatchUp(t: Trigger): Promise<void> {
  if (t.status !== 'active') return;
  if (t.source.type !== 'time') return;

  const now = Date.now();
  const next = computeNextFire(t.source.spec);

  if (next === null) {
    // 'at' trigger's moment has passed. Catch-up policy: if missed
    // within grace, fire once; otherwise mark completed silently.
    const at = new Date(t.source.spec.type === 'at' ? t.source.spec.iso : 0);
    const lateMs = now - at.getTime();
    if (lateMs <= SENTINEL_LIMITS.CATCHUP_GRACE_MS) {
      logger.info({
        msg: 'sentinel.scheduler.boot_catchup',
        triggerId: t.id,
        lateBy: `${Math.round(lateMs / 1000)}s`,
      });
      await fireTrigger(t, { catchUp: true, testMode: false });
    } else {
      logger.info({
        msg: 'sentinel.scheduler.boot_skip_stale',
        triggerId: t.id,
        lateBy: `${Math.round(lateMs / 60_000)}min`,
        graceMin: SENTINEL_LIMITS.CATCHUP_GRACE_MS / 60_000,
      });
      const updated: Trigger = {
        ...t,
        status: 'completed',
        statusReason: 'stale: server was down past catch-up grace',
      };
      delete updated.nextFireAt;
      await saveTrigger(updated);
    }
    return;
  }

  // Recurring trigger: just refresh nextFireAt. Don't backfill —
  // running "you have new mail" five times because somora was down
  // for an hour is worse than not running it at all (memory note
  // for the user: see history if needed).
  const updated: Trigger = { ...t, nextFireAt: next.toISOString() };
  await saveTrigger(updated);
}

/** Boot the scheduler. Idempotent on multiple calls. */
export async function startSentinel(): Promise<void> {
  if (started) return;
  await loadTriggers();
  const triggers = listTriggers();
  logger.info({
    msg: 'sentinel.scheduler.boot',
    triggersLoaded: triggers.length,
    active: triggers.filter((t) => t.status === 'active').length,
  });
  // Apply catch-up to active triggers sequentially. firings here
  // happen in fire-and-forget background; the await is just for the
  // state update.
  for (const t of triggers) {
    await applyBootCatchUp(t);
  }
  started = true;
  reschedule();
}

/** Stop the scheduler — used in tests; production never stops it. */
export function stopSentinel(): void {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
    nextFireAt = null;
  }
  started = false;
}

/** Diagnostic — exposed for /sentinel/state and tests. */
export function schedulerStatus(): { started: boolean; nextFireAt: number | null } {
  return { started, nextFireAt };
}
