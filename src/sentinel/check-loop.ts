// The check side of the scheduler (Sentinel phase 2): when a check is
// due, run its script, ask check-logic.ts what follows, persist that,
// and only then wake the agent.
//
// The scheduler keeps its single timer; a check trigger's due time is
// `nextCheckAt` in its check state (sentinel/check-state/<id>.json),
// not `nextFireAt` in triggers.json — a check every 15 s would otherwise
// rewrite the watched registry 5760 times a day.
//
// Order of things after a check (E1 of the concept): the new state is
// saved BEFORE the wake, so a crash in between does not wake twice, and
// a turn that fails does not wake again for the same change. When the
// wake is not started at all (cooldown, the agent's concurrency cap),
// the change is rolled back and the check runs again soon.

import { createHash } from 'node:crypto';
import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { afterDecision, afterItemDecisions, afterRun, initialCheckState, nextAfterError, stableJson, type CheckLimits, type CheckStep, type WakeReason } from './check-logic.ts';
import { judgeCheckData, judgeItems } from './check-judge.ts';
import { runCheck } from './check-runner.ts';
import { cachedCheckState, loadCheckState, saveCheckState } from './check-store.ts';
import { parseInterval } from './schedule.ts';
import { getTrigger, recordFire, saveTrigger } from './store.ts';
import type { CheckSource, CheckState, Trigger } from './types.ts';

/** What a wake carries into the evidence block (dispatcher.ts). */
export interface CheckWake {
  reason: WakeReason;
  state: CheckState;
  data?: unknown;
}

export type FireOutcome = 'started' | 'skipped' | 'error';

export interface CheckLoopDeps {
  config: () => Config | undefined;
  fire: (trigger: Trigger, wake: CheckWake) => Promise<FireOutcome>;
  reschedule: () => void;
}

/** Retry after a wake that could not start, or a full check slot. */
const WAKE_RETRY_MS = 30_000;
const SLOT_RETRY_MS = 2_000;

const inflight = new Set<string>();
/** Slots were full: look again at this time (memory only, counts nothing). */
const deferredUntil = new Map<string, number>();

export function isCheckTrigger(t: Trigger): t is Trigger & { source: CheckSource } {
  return t.source.type === 'check';
}

export function isCheckInflight(id: string): boolean {
  return inflight.has(id);
}

export function checksRunning(): number {
  return inflight.size;
}

function limitsOf(config: Config | undefined): Config['sentinel']['checks'] {
  return config?.sentinel?.checks ?? {
    minIntervalOnceMs: 15_000,
    minIntervalMs: 60_000,
    maxDeadlineMs: 86_400_000,
    timeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    maxOutputBytes: 65_536,
    maxConcurrent: 4,
    errorStreak: 3,
    maxWakesPerDay: 24,
    maxItemsPerCheck: 20,
    parallelDecisions: 4,
  };
}

/** When the scheduler must look at this check trigger. A trigger with
 *  no loaded state is due now: the run loads it first and only then
 *  decides whether a check is really due. */
export function checkDueAt(t: Trigger, now: number = Date.now()): number | null {
  if (inflight.has(t.id)) return null;
  const deferred = deferredUntil.get(t.id) ?? 0;
  const s = cachedCheckState(t.id);
  const at = s?.nextCheckAt ? new Date(s.nextCheckAt).getTime() : now;
  return Math.max(Number.isNaN(at) ? now : at, deferred);
}

/** A few seconds to a minute, the same for the same trigger — so after
 *  a restart the checks do not all start in the same second. */
export function bootJitterMs(id: string, intervalMs: number): number {
  const h = createHash('sha256').update(id).digest().readUInt32BE(0);
  const span = Math.max(1_000, Math.min(intervalMs, 60_000) - 5_000);
  return 5_000 + (h % span);
}

/** After a restart: no catch-up burst, one fresh check soon. */
export async function bootCheck(t: Trigger, now: Date = new Date()): Promise<void> {
  if (t.status !== 'active' || !isCheckTrigger(t)) return;
  const state = (await loadCheckState(t.id)) ?? initialCheckState(t.id, now);
  const interval = safeInterval(t.source);
  await saveCheckState({ ...state, nextCheckAt: new Date(now.getTime() + bootJitterMs(t.id, interval)).toISOString() });
}

function safeInterval(source: CheckSource): number {
  try {
    return parseInterval(source.interval);
  } catch {
    return 60_000;
  }
}

function nextCheckAfter(source: CheckSource, step: CheckStep, now: Date, limits: Config['sentinel']['checks']): string {
  // A floor raised in config.yaml after creation applies from the next check.
  const interval = Math.max(safeInterval(source), source.mode === 'once' ? limits.minIntervalOnceMs : limits.minIntervalMs);
  let at = now.getTime() + (step.state.last && !step.state.last.ok ? nextAfterError(interval, step.state.errorStreak) : interval);
  if (source.mode === 'once' && source.deadline) {
    const deadline = new Date(source.deadline).getTime();
    // The last check lands on the deadline, so "not ready by then" is said on time.
    if (deadline > now.getTime()) at = Math.min(at, deadline);
  }
  return new Date(at).toISOString();
}

/** The same check as when the run started: same source and evaluator. */
function sameCheck(a: Trigger, b: Trigger): boolean {
  return stableJson(a.source) === stableJson(b.source) && stableJson(a.evaluator ?? null) === stableJson(b.evaluator ?? null);
}

/** Start the due check of this trigger without waiting for it. */
export function startDueCheck(trigger: Trigger, deps: CheckLoopDeps): void {
  const cfg = limitsOf(deps.config());
  if (inflight.has(trigger.id)) return;
  if (inflight.size >= cfg.maxConcurrent) {
    // All slots busy: try again shortly, without counting anything.
    deferredUntil.set(trigger.id, Date.now() + SLOT_RETRY_MS);
    queueMicrotask(deps.reschedule);
    logger.debug({ msg: 'sentinel.check.slot_full', triggerId: trigger.id, running: inflight.size });
    return;
  }
  deferredUntil.delete(trigger.id);
  inflight.add(trigger.id);
  void runDueCheck(trigger, deps)
    .catch((err) => logger.error({ msg: 'sentinel.check.crashed', triggerId: trigger.id, err: (err as Error).message }))
    .finally(() => {
      inflight.delete(trigger.id);
      deps.reschedule();
    });
}

/** One check, start to end. Exported for tests. */
export async function runDueCheck(trigger: Trigger, deps: CheckLoopDeps, now: () => Date = () => new Date()): Promise<void> {
  if (!isCheckTrigger(trigger) || trigger.status !== 'active') return;
  const config = deps.config();
  const cfg = limitsOf(config);
  const limits: CheckLimits = { errorStreak: cfg.errorStreak, maxWakesPerDay: cfg.maxWakesPerDay, maxItemsPerCheck: cfg.maxItemsPerCheck };
  const source = trigger.source;

  const loaded = await loadCheckState(trigger.id);
  let state = loaded ?? initialCheckState(trigger.id, now());
  // Loaded from disk for the first time and not due yet: now that the
  // state is in memory, the scheduler knows the real time.
  if (state.nextCheckAt && new Date(state.nextCheckAt).getTime() > now().getTime() + 1000) return;
  if (state.pausedAt) {
    // First check after a resume: a fresh start for the error count.
    logger.info({ msg: 'sentinel.check.resumed', triggerId: trigger.id, name: trigger.name, agent: trigger.dispatch.agent });
    const { pausedAt: _p, ...rest } = state;
    state = { ...rest, errorStreak: 0 };
  }

  const art = trigger.evaluator?.type === 'decision' ? 2 : 1;
  if (!config) {
    await saveCheckState({ ...state, nextCheckAt: new Date(now().getTime() + WAKE_RETRY_MS).toISOString() });
    return;
  }
  const timeoutMs = Math.min(source.timeoutMs ?? cfg.timeoutMs, cfg.maxTimeoutMs);
  const run = await runCheck({
    triggerId: trigger.id,
    agent: trigger.dispatch.agent,
    script: source.script,
    art,
    timeoutMs,
    maxOutputBytes: cfg.maxOutputBytes,
    config,
    ...(trigger.lastFireAt ? { lastFiredAt: trigger.lastFireAt } : {}),
  });

  // The trigger may have been paused, deleted or given a new script
  // while the check ran: the answer belongs to what no longer exists.
  const fresh = getTrigger(trigger.id);
  if (!fresh || fresh.status !== 'active' || !isCheckTrigger(fresh) || fresh.source.script.sha256 !== source.script.sha256) {
    logger.info({ msg: 'sentinel.check.discarded', triggerId: trigger.id, reason: !fresh ? 'deleted' : fresh.status !== 'active' ? fresh.status : 'script changed' });
    return;
  }

  const at = now();
  const evaluator = fresh.evaluator ?? { type: 'ready' as const };
  let step = afterRun({ source: fresh.source, evaluator, state, run, now: at, limits });
  const judging = Boolean(step.needDecision || step.needItems);
  if (step.needDecision) {
    const outcome = await judgeCheckData(fresh, step.needDecision.data, config);
    step = afterDecision({ source: fresh.source, state: step.state, hash: step.needDecision.hash, data: step.needDecision.data, outcome, now: at, limits });
  } else if (step.needItems) {
    const results = await judgeItems(fresh, step.needItems.items, config, cfg.parallelDecisions);
    step = afterItemDecisions({ source: fresh.source, state: step.state, results, more: step.needItems.more, now: at, limits });
  }
  if (judging) {
    // Judging takes seconds (one question per item with perItem): the
    // trigger may have been deleted, paused or changed meanwhile. Its
    // answer then belongs to what no longer exists — saving it would
    // overwrite an update's fresh start, wake for a deleted trigger, or
    // save a deleted once trigger back as completed (review 2026-10-26).
    const after = getTrigger(trigger.id);
    if (!after || after.status !== 'active' || !sameCheck(after, fresh)) {
      logger.info({ msg: 'sentinel.check.discarded', triggerId: trigger.id, reason: !after ? 'deleted while judging' : after.status !== 'active' ? `${after.status} while judging` : 'changed while judging' });
      return;
    }
  }
  if (step.judged) {
    await recordFire(fresh.id, { firedAt: at.toISOString(), scheduledFor: at.toISOString(), outcome: 'judged', note: step.judged.slice(0, 1000) });
  }

  logger.info({
    msg: 'sentinel.check.ran',
    triggerId: fresh.id,
    agent: fresh.dispatch.agent,
    ms: run.ms,
    ok: run.ok,
    ...(run.ok ? { ready: run.answer.ready, final: run.answer.final } : { error: run.error.slice(0, 300), errorClass: run.errorClass }),
    ...(step.state.last?.decision && step.state.last.at === at.toISOString() ? { decision: step.state.last.decision.value } : {}),
    ...(step.wake ? { wake: step.wake.reason } : {}),
    ...(step.complete ? { complete: step.complete } : {}),
    ...(step.pause ? { pause: step.pause.kind } : {}),
  });

  // Pause: save the state, then the trigger, then tell the inbox.
  if (step.pause) {
    await saveCheckState({ ...step.state, errorStreak: 0, pausedAt: at.toISOString() });
    const updated: Trigger = step.pause.kind === 'cap'
      ? { ...fresh, status: 'paused', statusReason: `auto-paused: ${step.pause.reason}`, autoPausedForDayUtc: at.toISOString().slice(0, 10) }
      : { ...fresh, status: 'error', statusReason: `auto-paused: ${step.pause.reason.slice(0, 300)}` };
    await saveTrigger(updated);
    await recordFire(fresh.id, { firedAt: at.toISOString(), scheduledFor: at.toISOString(), outcome: 'error', error: `check paused: ${step.pause.reason.slice(0, 300)}` });
    logger.warn({
      msg: 'sentinel.check.paused',
      triggerId: fresh.id,
      name: fresh.name,
      agent: fresh.dispatch.agent,
      kind: step.pause.kind,
      reason: step.pause.reason.slice(0, 500),
    });
    return;
  }

  const next = { ...step.state, nextCheckAt: nextCheckAfter(fresh.source, step, at, cfg) };
  await saveCheckState(next);

  if (step.wake) {
    const outcome = await deps.fire(fresh, { reason: step.wake.reason, state: next, data: step.wake.data });
    if (outcome === 'skipped') {
      // Not started: as if this check never saw the change, try again
      // soon — or when the trigger's cooldown between wakes is over, so
      // a waiting wake does not rerun the script (and the decision
      // model) every 30 s.
      const cooldownLeft = fresh.policy?.cooldownMs && fresh.lastSuccessAt
        ? fresh.policy.cooldownMs - (at.getTime() - new Date(fresh.lastSuccessAt).getTime())
        : 0;
      const rolledBack: CheckState = {
        ...next,
        lastReady: state.lastReady,
        lastDataHash: state.lastDataHash,
        seenItems: state.seenItems,
        baselineTaken: state.baselineTaken,
        wakeCount: state.wakeCount,
        wakesToday: state.wakesToday,
        nextCheckAt: new Date(at.getTime() + Math.max(WAKE_RETRY_MS, cooldownLeft + 1000)).toISOString(),
      };
      // Fields the state had not before the wake was charged go too: the
      // first wake of a day that could not start must not count against
      // that day's cap (review 2026-10-26).
      for (const k of ['lastReady', 'lastDataHash', 'seenItems', 'wakesToday'] as const) if (rolledBack[k] === undefined) delete rolledBack[k];
      await saveCheckState(rolledBack);
      return;
    }
    if (outcome === 'error') return; // fireTrigger counted it; the trigger stays as it is
  }

  if (step.complete) {
    // Deleted meanwhile (the wake's turn may have run long): stays deleted.
    const latest = getTrigger(fresh.id);
    if (latest?.status === 'active') await saveTrigger({ ...latest, status: 'completed', statusReason: step.complete });
  }
}
