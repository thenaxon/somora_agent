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

import { homedir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { logger } from '../server/logger.ts';
import { loopbackFetch } from '../server/loopback-fetch.ts';
import { acquireSessionLock } from '../server/session-queue.ts';
import { runChatTurn } from '../server/run-turn.ts';
import { newTaskId, registerTask, completeTask, failTask } from '../server/async-tasks.ts';
import { resolveSessionId, createSession } from '../storage/sessions.ts';
import { loadPersona } from '../persona/loader.ts';
import { reserveSpawnSlot, releaseSpawnSlot } from '../tools/agents/spawn.ts';
import {
  computeNextFire,
  utcDayStr,
  utcMidnightAfter,
  isDailyCapResumeDue,
} from './schedule.ts';
import { buildFirePrompt } from './dispatcher.ts';
import {
  countFiresToday,
  deleteTrigger,
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
// `publishSse` mirrors what /chat/send + A2A spawn-async pass to
// runChatTurn — without it, the woken agent's user_message + all
// downstream deltas/tool-calls/replies are appended to the JSONL but
// not broadcast over SSE. Web/mobile clients only see them on the
// next history-refetch (= page reload). Reported live by user
// 2026-05-17: "muss reloaden um die nachricht zu sehen + agent's
// reaktion ist gar nicht im stream". Sentinel must broadcast like
// any other turn entry-point.
type PublishFn = (event: unknown) => Promise<void> | void;
type PublishEvent = (agent: string, session: string, event: unknown) => Promise<void> | void;
let injectedChatTurnDeps: ChatTurnDeps | null = null;
let injectedPublishEvent: PublishEvent | null = null;
let completedRetentionDays = 7;

export function configureSentinel(args: {
  chatTurnDeps: ChatTurnDeps;
  publishEvent?: PublishEvent;
  completedRetentionDays?: number;
}): void {
  injectedChatTurnDeps = args.chatTurnDeps;
  if (args.publishEvent) injectedPublishEvent = args.publishEvent;
  if (typeof args.completedRetentionDays === 'number') {
    completedRetentionDays = args.completedRetentionDays;
  }
}

void ({} as PublishFn); // type kept for clarity; resolved per-fire below

/**
 * Garbage-collect terminal-state triggers whose lastFireAt is older
 * than `completedRetentionDays`. Setting that config to 0 disables GC
 * entirely (user/agent must delete manually).
 *
 * Runs once at boot and then daily — most installations have a small
 * trigger count so a daily sweep is fine. We don't keep a separate
 * timer; we re-use the scheduler's daily re-arm tick as the natural
 * cadence anchor (more frequent than necessary is harmless because
 * the operation is cheap).
 */
async function gcStaleTriggers(): Promise<number> {
  if (completedRetentionDays <= 0) return 0;
  const cutoff = Date.now() - completedRetentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const t of listTriggers()) {
    if (t.status !== 'completed') continue;
    const anchor = t.lastFireAt ? new Date(t.lastFireAt).getTime() : NaN;
    if (Number.isNaN(anchor)) continue;
    if (anchor < cutoff) {
      await deleteTrigger(t.id);
      removed++;
      logger.info({
        msg: 'sentinel.scheduler.gc_completed',
        triggerId: t.id,
        ageDays: Math.round((Date.now() - anchor) / (24 * 60 * 60 * 1000)),
      });
    }
  }
  return removed;
}

/** Flip daily-cap-paused triggers back to `active` once the UTC day has
 *  rolled over (their fire count has reset, so they can run again).
 *  Returns how many were revived. User-set and error pauses carry no
 *  `autoPausedForDayUtc` marker and are left untouched. */
async function resumeDailyCapPaused(now: Date = new Date()): Promise<number> {
  let resumed = 0;
  for (const t of listTriggers()) {
    if (t.status !== 'paused' || !t.autoPausedForDayUtc) continue;
    if (!isDailyCapResumeDue(t.autoPausedForDayUtc, now)) continue; // still the capped day
    const revived: Trigger = { ...t, status: 'active' };
    delete revived.autoPausedForDayUtc;
    delete revived.statusReason;
    await saveTrigger(revived);
    await advanceNextFire(revived);
    resumed++;
    logger.info({
      msg: 'sentinel.scheduler.daily_cap_resumed',
      triggerId: t.id,
      pausedForDay: t.autoPausedForDayUtc,
    });
  }
  return resumed;
}

/** Earliest instant the scheduler must wake to run resumeDailyCapPaused,
 *  or null if nothing is daily-cap-paused. Returns `now` when a paused
 *  trigger is already past its resume day (overdue → wake immediately).
 *  This keeps the scheduler from going fully idle while a cap-paused
 *  trigger is waiting for the day to roll over. */
function nextResumeWakeAt(now: number = Date.now()): number | null {
  let earliest: number | null = null;
  for (const t of listTriggers()) {
    if (t.status !== 'paused' || !t.autoPausedForDayUtc) continue;
    if (isDailyCapResumeDue(t.autoPausedForDayUtc, new Date(now))) return now; // overdue
    const boundary = utcMidnightAfter(new Date(now));
    if (earliest === null || boundary < earliest) earliest = boundary;
  }
  return earliest;
}

let started = false;
let nextTimer: NodeJS.Timeout | null = null;
let nextFireAt: number | null = null;
let storeWatcher: ReturnType<typeof chokidar.watch> | null = null;
let watcherReloadTimer: NodeJS.Timeout | null = null;

// Triggers currently in fire-and-forget dispatch. pickNextDue skips
// these so a re-entry (via watcher self-trigger after saveTrigger, or
// re-arm from advanceNextFire, etc.) can't double-fire while the
// previous async IIFE is still in flight. Cleared in the IIFE's
// finally block.
const inflightFires = new Set<string>();

/** Compute the next fire instant across ALL active triggers + a Trigger
 *  pointer. Returns null when no triggers are armed. */
function pickNextDue(now: number = Date.now()): { trigger: Trigger; fireAt: number } | null {
  let pick: { trigger: Trigger; fireAt: number } | null = null;
  for (const t of listTriggers()) {
    if (t.status !== 'active') continue;
    if (!t.nextFireAt) continue;
    // A trigger whose previous fire is still running must not be
    // re-picked — its in-memory cache state (e.g. nextFireAt) hasn't
    // been advanced yet, so we'd just fire it again immediately.
    if (inflightFires.has(t.id)) continue;
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
  // Also wake for the daily-cap resume boundary so a scheduler with only
  // cap-paused triggers doesn't go idle forever and strand them.
  const resumeAt = nextResumeWakeAt();
  let wakeAt: number | null = pick ? pick.fireAt : null;
  let wakeReason: 'fire' | 'daily_cap_resume' = 'fire';
  if (resumeAt !== null && (wakeAt === null || resumeAt < wakeAt)) {
    wakeAt = resumeAt;
    wakeReason = 'daily_cap_resume';
  }
  if (wakeAt === null) {
    logger.info({ msg: 'sentinel.scheduler.idle', reason: 'no active triggers with future fire' });
    return;
  }
  const delay = Math.max(0, wakeAt - Date.now());
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
    ...(pick && wakeReason === 'fire' ? { triggerId: pick.trigger.id } : {}),
    wakeReason,
    fireAt: new Date(wakeAt).toISOString(),
    delayMs: delay,
    armedMs: safeDelay,
  });
}

async function onTimer(): Promise<void> {
  // Belt-and-suspenders against a hypothetically-dead watcher: every
  // timer tick we re-read the store from disk before deciding what
  // to do. Cheap (a few KB JSON parse), and if the watcher silently
  // died (e.g. inotify limit hit, NFS hiccup, OS-level weirdness)
  // we still resync state at least once per re-arm tick (daily cap
  // = at most 24h drift).
  try {
    await loadTriggers();
  } catch (err) {
    logger.warn({
      msg: 'sentinel.scheduler.timer_reload_failed',
      err: (err as Error).message,
    });
  }
  // Revive any daily-cap-paused triggers whose UTC day has rolled over
  // before deciding what's due — a revived trigger becomes pickable here.
  try {
    await resumeDailyCapPaused();
  } catch (err) {
    logger.warn({
      msg: 'sentinel.scheduler.daily_cap_resume_failed',
      err: (err as Error).message,
    });
  }
  // Re-pick at fire time — registry may have changed during sleep,
  // and we want the actually-due trigger (not a stale memory of which
  // was due when we armed).
  const pick = pickNextDue();
  if (!pick) {
    // Idle wake — opportunistic GC sweep so retention runs at least
    // daily without a separate timer.
    void gcStaleTriggers();
    reschedule();
    return;
  }
  if (pick.fireAt > Date.now() + 1000) {
    // We woke up early (probably re-arm cap). Re-schedule + GC.
    void gcStaleTriggers();
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
      // Auto-pause until tomorrow. The UTC-day marker lets the resume
      // sweep (resumeDailyCapPaused) flip this back to 'active' once the
      // day rolls over — without it the pause was permanent and only a
      // manual resume revived the trigger (Juni-Audit 2026-06).
      const updated: Trigger = {
        ...trigger,
        status: 'paused',
        statusReason: `auto-paused: daily cap (${todayCount}) reached`,
        autoPausedForDayUtc: utcDayStr(now),
      };
      await saveTrigger(updated);
      reschedule();
      return;
    }
  }

  // ── Actually fire: route through the in-process /spawn-async core ──
  const dispatch = trigger.dispatch;

  // Make sure the agent exists; never silently swallow this.
  if (!(await loadPersona(dispatch.agent))) {
    await markError(trigger, `agent '${dispatch.agent}' not found`, scheduledFor, now, opts.catchUp);
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
      if (isExactId) throw new Error(`session '${dispatch.session}' not found`);
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
  // Bind a per-fire publishSse so the woken agent's user_message and
  // every downstream agent event reach SSE-subscribed clients live —
  // same as /chat/send and A2A spawn-async. Without this, the turn
  // only lands in the JSONL and clients need a page-reload to see it.
  const publishSse =
    injectedPublishEvent !== null
      ? (event: unknown) => injectedPublishEvent!(dispatch.agent, session, event)
      : undefined;
  // Mark in-flight BEFORE spawning the IIFE so pickNextDue can't re-
  // pick this trigger via a watcher-driven reschedule loop during
  // the fire. Cleared in the IIFE's finally.
  inflightFires.add(trigger.id);
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
        fromSystem: 'sentinel',
        deps,
        ...(publishSse ? { publishSse: publishSse as never } : {}),
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
      inflightFires.delete(trigger.id);
    }
  })();
}

/** Dispatch a test fire from any process.
 *
 *  Why this exists: `fireTrigger` requires `injectedChatTurnDeps`, which
 *  is set only in the main server boot (`configureSentinel({chatTurnDeps})`).
 *  When the `sentinel` TOOL is invoked from claude-cli / codex-cli
 *  engines, the tool handler runs in an MCP-child process that has its
 *  own module instance with deps==null — calling fireTrigger directly
 *  records `outcome:"error"` with `"sentinel not initialized (no
 *  chatTurnDeps)"` and increments errorStreak.
 *
 *  Same pattern as `spawnAsyncViaHttp` in tools/agents/spawn.ts: when
 *  not in-process, reach back to the main server's existing HTTP
 *  endpoint (`POST /sentinel/triggers/:id/test`). SOMORA_PORT env is
 *  set by main-server boot and propagated into the MCP-child env via
 *  src/mcp/config.ts. */
export async function dispatchTestFire(
  trigger: Trigger,
): Promise<{ via: 'in-process' | 'http' }> {
  if (injectedChatTurnDeps) {
    await fireTrigger(trigger, { catchUp: false, testMode: true });
    return { via: 'in-process' };
  }
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const url = `${scheme}://${host}:${port}/sentinel/triggers/${encodeURIComponent(trigger.id)}/test`;
  const res = await loopbackFetch(url, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sentinel test HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return { via: 'http' };
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
  const spec = trigger.source.spec;
  // Anchor 'every' triggers on the fire that just ran (its scheduled
  // nextFireAt) so the interval doesn't drift by the agent-turn duration
  // — matches the anti-drift claim in this module's header.
  const anchor =
    spec.type === 'every' && trigger.nextFireAt ? new Date(trigger.nextFireAt) : undefined;
  const next = computeNextFire(spec, new Date(), anchor);
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

  // Recurring trigger. Did we miss one or more scheduled fires while
  // somora was down? Decide based on `policy.missedFiresPolicy`:
  //   skip (default) — just compute next future fire, no backfill
  //   catchUpOnce    — one historical fire with catchUp:true, then
  //                    arm for the regular next
  //   catchUpAll     — fire ONCE per missed instant, capped at
  //                    MAX_BACKFILL_FIRES (24)
  const missedPolicy = t.policy?.missedFiresPolicy ?? 'skip';
  const lastAnchor = t.lastSuccessAt
    ? new Date(t.lastSuccessAt).getTime()
    : new Date(t.createdAt).getTime();
  const missed = enumerateMissedFires(t, lastAnchor, now);

  if (missed.length > 0 && missedPolicy !== 'skip') {
    const toFire = missedPolicy === 'catchUpOnce' ? 1 : missed.length;
    const capped = Math.min(toFire, SENTINEL_LIMITS.MAX_BACKFILL_FIRES);
    logger.info({
      msg: 'sentinel.scheduler.boot_catchup_recurring',
      triggerId: t.id,
      missedCount: missed.length,
      firing: capped,
      policy: missedPolicy,
    });
    for (let i = 0; i < capped; i++) {
      await fireTrigger(t, { catchUp: true, testMode: false });
    }
  } else if (missed.length > 0) {
    logger.info({
      msg: 'sentinel.scheduler.boot_skip_recurring',
      triggerId: t.id,
      missedCount: missed.length,
      policy: missedPolicy,
    });
  }

  // Refresh nextFireAt regardless.
  const updated: Trigger = { ...t, nextFireAt: next.toISOString() };
  await saveTrigger(updated);
}

/** Walk forward from `since` and collect every instant the trigger's
 *  spec would have fired up to `until`. Used by boot-catch-up for
 *  recurring triggers with non-skip missedFiresPolicy. Capped at
 *  MAX_BACKFILL_FIRES + 1 so we don't iterate forever on a misconfigured
 *  spec. */
function enumerateMissedFires(t: Trigger, since: number, until: number): Date[] {
  if (t.source.type !== 'time') return [];
  const spec = t.source.spec;
  // `at` triggers handled separately (single-instant); enumerate is
  // only meaningful for recurring sources.
  if (spec.type === 'at') return [];

  const fires: Date[] = [];
  let cursor = since;
  while (fires.length <= SENTINEL_LIMITS.MAX_BACKFILL_FIRES) {
    const next = computeNextFire(spec, new Date(cursor));
    if (next === null) break;
    const t = next.getTime();
    if (t >= until) break;
    fires.push(next);
    cursor = t;
  }
  return fires;
}

/** Boot the scheduler. Idempotent on multiple calls.
 *
 *  Also installs a filesystem watcher on the triggers.json file so the
 *  main server picks up changes written by MCP-child-process tool
 *  invocations. Why this matters: agents driven by claude-cli or
 *  codex-cli engines execute the `sentinel` tool inside a per-turn
 *  MCP child process — that child has its own module-instance of this
 *  scheduler with `started===false`, so a `reschedule()` call there is
 *  a no-op. The child still writes the trigger JSON to disk; this
 *  watcher in the main process notices and re-loads + re-arms. */
export async function startSentinel(): Promise<void> {
  if (started) return;
  await loadTriggers();
  const removed = await gcStaleTriggers();
  // Revive triggers that were daily-cap-paused before a restart on a
  // previous UTC day — list AFTER so the revived ones get boot catch-up.
  const resumedAtBoot = await resumeDailyCapPaused();
  const triggers = listTriggers();
  logger.info({
    msg: 'sentinel.scheduler.boot',
    triggersLoaded: triggers.length,
    active: triggers.filter((t) => t.status === 'active').length,
    completedRetentionDays,
    gcRemovedAtBoot: removed,
    resumedAtBoot,
  });
  for (const t of triggers) {
    if (t.status !== 'completed') await applyBootCatchUp(t);
  }
  started = true;
  installStoreWatcher();
  reschedule();
}

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const SENTINEL_DIR = join(SOMORA_HOME, 'sentinel');
const TRIGGERS_PATH = join(SENTINEL_DIR, 'triggers.json');

function installStoreWatcher(): void {
  if (storeWatcher) return;
  // Watch the PARENT DIRECTORY, not the single file. store.ts writes
  // via tmp-file + atomic rename — a chokidar watch on the concrete
  // file path hangs on the old inode, which gets unlinked by the
  // rename. Subsequent writes go to a NEW inode and produce no events
  // on the dead watch. Watching the directory means every event in
  // the dir (add/change/unlink for either the tmp file or the
  // renamed-into-place real file) is reported; we filter to the
  // triggers.json basename below. Confirmed 2026-05-17 live with a
  // missed `every 3m` create after a previous one-shot fire had
  // rewritten the file.
  storeWatcher = chokidar.watch(SENTINEL_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
    depth: 0,
  });
  const onChange = (event: string, eventPath: string) => {
    if (eventPath !== TRIGGERS_PATH) return; // ignore history-dir + tmp files
    if (watcherReloadTimer) clearTimeout(watcherReloadTimer);
    watcherReloadTimer = setTimeout(async () => {
      watcherReloadTimer = null;
      try {
        await loadTriggers();
        logger.info({
          msg: 'sentinel.scheduler.store_reloaded',
          event,
          activeCount: listTriggers().filter((t) => t.status === 'active').length,
        });
        reschedule();
      } catch (err) {
        logger.warn({
          msg: 'sentinel.scheduler.store_reload_failed',
          err: (err as Error).message,
        });
      }
    }, 200);
  };
  storeWatcher.on('add', (p) => onChange('add', p));
  storeWatcher.on('change', (p) => onChange('change', p));
  storeWatcher.on('unlink', (p) => onChange('unlink', p));
  logger.info({
    msg: 'sentinel.scheduler.watcher_installed',
    dir: SENTINEL_DIR,
    file: TRIGGERS_PATH,
  });
}

/** Stop the scheduler — used in tests; production never stops it. */
export function stopSentinel(): void {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
    nextFireAt = null;
  }
  if (watcherReloadTimer) {
    clearTimeout(watcherReloadTimer);
    watcherReloadTimer = null;
  }
  if (storeWatcher) {
    void storeWatcher.close();
    storeWatcher = null;
  }
  started = false;
}

/** Diagnostic — exposed for /sentinel/state and tests. */
export function schedulerStatus(): { started: boolean; nextFireAt: number | null } {
  return { started, nextFireAt };
}
