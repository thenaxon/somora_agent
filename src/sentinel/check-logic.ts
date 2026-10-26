// What happens after a check (Sentinel phase 2) — pure, no clock, no
// files, so every case can be tested on its own. The scheduler runs the
// script (check-runner.ts), asks here, persists the new state BEFORE it
// wakes anyone (a crash between the two must not wake twice), then acts.
//
// Rules (private/sentinel-phase2/KONZEPT.md, decisions E1–E4):
//   once  — wake on the first `ready`, then done. Past the deadline:
//           wake once with the last state, then done.
//   watch — the first check only takes the starting state (unless
//           notifyOnFirst); then wake on the change not-ready → ready
//           (Art 1) or on new data the decision model rates high (Art 2).
//   final: "failed" — wake at once, then done, in either mode.
//   Errors — a permanent one (script missing or changed) pauses at
//           once; others count, with a growing pause between retries,
//           and pause after config sentinel.checks.errorStreak.
//   Wakes per day are capped (maxWakesPerDay); the cap pauses until the
//           next UTC day.
//   perItem (Art 2) — the data is a list; each item new to the check is
//           judged on its own and counts as seen only after its answer
//           (feedback 2026-10-20: one answer for six mails said not which,
//           and a script marking mails seen before the answer lost them).

import { createHash } from 'node:crypto';
import type { CheckResult, CheckSource, CheckState, Evaluator } from './types.ts';
import type { CheckRunOutcome } from './check-runner.ts';

export interface CheckLimits {
  errorStreak: number;
  maxWakesPerDay: number;
  /** perItem: items judged per check (config sentinel.checks.maxItemsPerCheck). */
  maxItemsPerCheck?: number;
}

/** perItem: keys of judged items kept, newest first out of the way last. */
export const SEEN_ITEMS_MAX = 2000;
const DEFAULT_ITEMS_PER_CHECK = 20;

export type WakeReason = 'ready' | 'changed' | 'first' | 'decision' | 'final-failed' | 'deadline';

export interface CheckStep {
  state: CheckState;
  wake?: { reason: WakeReason; data?: unknown };
  /** Mark the trigger completed, with this reason. */
  complete?: string;
  /** Pause the trigger: `error` (errors) or `cap` (wakes today, resumes tomorrow). */
  pause?: { kind: 'error' | 'cap'; reason: string };
  /** Art 2: the data must go to the decision model first. */
  needDecision?: { data: unknown; hash: string };
  /** Art 2 with perItem: these items go to the decision model, one
   *  question each; `more` new items wait for the next check. */
  needItems?: { items: Array<{ key: string; item: unknown }>; more: number };
  /** The decision model was asked: one line for the trigger's history. */
  judged?: string;
}

/** One item's answer, for afterItemDecisions. */
export interface ItemOutcome {
  key: string;
  item: unknown;
  outcome: { ok: true; wake: boolean; question: string; value: number | string; detail?: string } | { ok: false; error: string; permanent?: boolean };
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Stable text of the data, so the same data has the same fingerprint
 *  however the script ordered its keys. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function dataHash(data: unknown): string {
  return createHash('sha256').update(stableJson(data)).digest('hex').slice(0, 32);
}

/** Nothing to judge: no data, an empty list, object or text — also
 *  nested, like {"new_mails": []}. A script that prints only new items
 *  prints this most of the time. */
export function isEmptyData(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.every(isEmptyData);
  if (typeof v === 'object') return Object.values(v as object).every(isEmptyData);
  return false;
}

/** The items of a perItem check's data: the list itself, or the one
 *  list inside an object ({"mails": […]}). Anything else is one item.
 *  Empty items are left out. */
export function itemsOf(data: unknown): unknown[] {
  const list = listIn(data);
  return (list ?? [data]).filter((i) => !isEmptyData(i));
}

/** The list a script printed as `data`, or null when it is not one. */
export function listIn(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>);
    const lists = values.filter(Array.isArray);
    if (lists.length === 1 && values.every((v) => Array.isArray(v) || typeof v !== 'object' || v === null)) return lists[0] as unknown[];
  }
  return null;
}

/** What makes an item the same item next time: its `id` (or `key`,
 *  `uid`), else a fingerprint of the whole item. */
export function itemKey(item: unknown): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    for (const f of ['id', 'key', 'uid']) {
      const v = o[f];
      if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return `${f}:${String(v)}`;
    }
  }
  return `h:${dataHash(item)}`;
}

/** Add keys as seen at `at`, dropping the oldest over SEEN_ITEMS_MAX. */
export function markSeen(seen: Record<string, string> | undefined, keys: readonly string[], at: string): Record<string, string> {
  const next: Record<string, string> = { ...(seen ?? {}) };
  for (const k of keys) {
    delete next[k];
    next[k] = at;
  }
  const all = Object.keys(next);
  if (all.length <= SEEN_ITEMS_MAX) return next;
  const keep = Object.entries(next).sort((a, b) => a[1].localeCompare(b[1])).slice(-SEEN_ITEMS_MAX);
  return Object.fromEntries(keep);
}

/** Without perItem: a list of several items gets one answer for all. */
export function manyItemsWarning(data: unknown): string | undefined {
  const list = listIn(data);
  const n = list ? list.filter((i) => !isEmptyData(i)).length : 0;
  if (n < 2) return undefined;
  return `the data is a list of ${n} items, judged as one: the answer does not say which item, and the next check sees them as known. To judge each item on its own, set decision.perItem: true`;
}

export function initialCheckState(triggerId: string, now: Date): CheckState {
  return { triggerId, startedAt: now.toISOString(), checkCount: 0, wakeCount: 0, errorStreak: 0, baselineTaken: false };
}

/** The next check after an error: the interval, or longer while errors repeat. */
export function nextAfterError(intervalMs: number, streak: number): number {
  return Math.min(Math.max(intervalMs, BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1)), Math.max(intervalMs, BACKOFF_MAX_MS));
}

function preview(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  const s = typeof data === 'string' ? data : stableJson(data);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Count a wake against today's cap, or say it is used up. */
function chargeWake(state: CheckState, now: Date, limits: CheckLimits): CheckState | null {
  const day = utcDay(now);
  const today = state.wakesToday?.day === day ? state.wakesToday.count : 0;
  if (today >= limits.maxWakesPerDay) return null;
  return { ...state, wakeCount: state.wakeCount + 1, wakesToday: { day, count: today + 1 } };
}

function withWake(step: CheckStep, now: Date, limits: CheckLimits): CheckStep {
  if (!step.wake) return step;
  const charged = chargeWake(step.state, now, limits);
  if (charged) return { ...step, state: charged };
  const { wake: _dropped, complete: _c, ...rest } = step;
  return { ...rest, pause: { kind: 'cap', reason: `${limits.maxWakesPerDay} wake-ups today (sentinel.checks.maxWakesPerDay) — resumes tomorrow` } };
}

/** After the script ran. */
export function afterRun(args: {
  source: CheckSource;
  evaluator: Evaluator;
  state: CheckState;
  run: CheckRunOutcome;
  now: Date;
  limits: CheckLimits;
}): CheckStep {
  const { source, evaluator, run, now, limits } = args;
  const base: CheckState = { ...args.state, checkCount: args.state.checkCount + 1 };
  const result: CheckResult = { at: now.toISOString(), ms: run.ms, ok: run.ok };

  if (!run.ok) {
    result.error = run.error;
    result.errorClass = run.errorClass;
    const streak = base.errorStreak + 1;
    const state: CheckState = { ...base, errorStreak: streak, last: result };
    if (run.errorClass === 'permanent') return { state, pause: { kind: 'error', reason: run.error } };
    if (streak >= limits.errorStreak) return { state, pause: { kind: 'error', reason: `${streak} check errors in a row. Last: ${run.error}` } };
    return { state };
  }

  const a = run.answer;
  if (a.summary !== undefined) result.summary = a.summary;
  if (a.ready !== undefined) result.ready = a.ready;
  const pv = preview(a.data);
  if (pv !== undefined) result.dataPreview = pv;
  if (a.final) result.final = a.final;
  // The script ran: errors in a row end here — unless the data still
  // waits for the decision model, whose answer decides (a judged check
  // whose model stays down must still reach the pause, review 2026-10-26).
  let state: CheckState = { ...base, errorStreak: 0, last: result };

  if (a.final === 'failed') {
    return withWake({ state, wake: { reason: 'final-failed', data: a.data }, complete: 'the check reported a final failure' }, now, limits);
  }

  const pastDeadline = source.mode === 'once' && source.deadline !== undefined && now.getTime() >= new Date(source.deadline).getTime();

  if (evaluator.type === 'decision' && evaluator.perItem) {
    const all = itemsOf(a.data).map((item) => ({ key: itemKey(item), item }));
    if (source.mode === 'watch' && !state.baselineTaken) {
      state = { ...state, baselineTaken: true };
      // The starting items are known, not news — unless notifyOnFirst.
      if (!source.notifyOnFirst) return { state: { ...state, seenItems: markSeen(state.seenItems, all.map((i) => i.key), now.toISOString()) } };
    }
    const seen = state.seenItems ?? {};
    const fresh: Array<{ key: string; item: unknown }> = [];
    const keys = new Set<string>();
    for (const i of all) {
      if (seen[i.key] !== undefined || keys.has(i.key)) continue;
      keys.add(i.key);
      fresh.push(i);
    }
    if (fresh.length === 0) {
      if (pastDeadline) return withWake({ state, wake: { reason: 'deadline', data: a.data }, complete: 'deadline passed' }, now, limits);
      return { state };
    }
    const max = limits.maxItemsPerCheck ?? DEFAULT_ITEMS_PER_CHECK;
    return { state: { ...state, errorStreak: args.state.errorStreak }, needItems: { items: fresh.slice(0, max), more: Math.max(0, fresh.length - max) } };
  }

  if (evaluator.type === 'decision') {
    const warning = manyItemsWarning(a.data);
    if (warning) state = { ...state, last: { ...result, warning } };
    const hash = dataHash(a.data);
    if (source.mode === 'watch' && !state.baselineTaken) {
      state = { ...state, baselineTaken: true, lastDataHash: hash };
      if (!source.notifyOnFirst) return { state };
      return { state: { ...state, errorStreak: args.state.errorStreak }, needDecision: { data: a.data, hash } };
    }
    if (state.lastDataHash === hash || isEmptyData(a.data)) {
      // Seen, or nothing at all: the decision model is not asked.
      state = { ...state, lastDataHash: hash };
      if (pastDeadline) return withWake({ state, wake: { reason: 'deadline', data: a.data }, complete: 'deadline passed' }, now, limits);
      return { state };
    }
    return { state: { ...state, errorStreak: args.state.errorStreak }, needDecision: { data: a.data, hash } };
  }

  // Art 1
  const ready = a.ready === true;
  if (source.mode === 'once') {
    if (ready) return withWake({ state, wake: { reason: 'ready', data: a.data }, complete: 'condition met' }, now, limits);
    if (pastDeadline) return withWake({ state, wake: { reason: 'deadline', data: a.data }, complete: 'deadline passed without the condition' }, now, limits);
    return { state };
  }
  if (!state.baselineTaken) {
    state = { ...state, baselineTaken: true, lastReady: ready };
    if (ready && source.notifyOnFirst) return withWake({ state, wake: { reason: 'first', data: a.data } }, now, limits);
    return { state };
  }
  const was = state.lastReady === true;
  state = { ...state, lastReady: ready };
  if (ready && !was) return withWake({ state, wake: { reason: 'changed', data: a.data } }, now, limits);
  return { state };
}

/** Art 2, after the decision model answered (or failed). `value` is the
 *  number or choice the wake rule looked at. */
export function afterDecision(args: {
  source: CheckSource;
  state: CheckState;
  hash: string;
  data: unknown;
  outcome: { ok: true; wake: boolean; question: string; value: number | string; detail?: string } | { ok: false; error: string; permanent?: boolean };
  now: Date;
  limits: CheckLimits;
}): CheckStep {
  const { source, hash, data, outcome, now, limits } = args;
  const last: CheckResult = { ...(args.state.last ?? { at: now.toISOString(), ms: 0, ok: true }) };
  if (!outcome.ok) {
    // Not reachable or refused: no wake, a check error (decision 5) —
    // and the data stays unseen, so it is judged again next time.
    last.ok = false;
    last.error = `decision model: ${outcome.error}`;
    last.errorClass = outcome.permanent ? 'permanent' : 'temporary';
    const streak = args.state.errorStreak + 1;
    const state: CheckState = { ...args.state, errorStreak: streak, last };
    const judged = `no answer from the decision model, the data is judged again next check — ${outcome.error}`;
    if (outcome.permanent) return { state, judged, pause: { kind: 'error', reason: last.error } };
    if (streak >= limits.errorStreak) return { state, judged, pause: { kind: 'error', reason: `${streak} check errors in a row. Last: ${last.error}` } };
    return { state, judged };
  }
  last.decision = { question: outcome.question, value: outcome.value, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  const state: CheckState = { ...args.state, lastDataHash: hash, errorStreak: 0, last, lastDecision: { at: now.toISOString(), ...last.decision } };
  const pastDeadline = source.mode === 'once' && source.deadline !== undefined && now.getTime() >= new Date(source.deadline).getTime();
  const judged = `${outcome.question} → ${outcome.value}${outcome.detail ? ` (${outcome.detail})` : ''}${outcome.wake ? ' — wakes' : ''}${last.warning ? `. Warning: ${last.warning}` : ''}`;
  if (outcome.wake) {
    return withWake({ state, judged, wake: { reason: 'decision', data }, ...(source.mode === 'once' ? { complete: 'condition met' } : {}) }, now, limits);
  }
  if (pastDeadline) return withWake({ state, judged, wake: { reason: 'deadline', data }, complete: 'deadline passed without the condition' }, now, limits);
  return { state, judged };
}

const short = (v: number | string) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v);

/** Art 2 with perItem, after the decision model answered each item. An
 *  item counts as seen only with an answer; one without is asked again
 *  at the next check. Wakes once for all items above the rule, with
 *  just those items as the data. */
export function afterItemDecisions(args: {
  source: CheckSource;
  state: CheckState;
  results: readonly ItemOutcome[];
  /** New items left for the next check (over maxItemsPerCheck). */
  more: number;
  now: Date;
  limits: CheckLimits;
}): CheckStep {
  const { source, results, more, now, limits } = args;
  const at = now.toISOString();
  const last: CheckResult = { ...(args.state.last ?? { at, ms: 0, ok: true }) };
  const answered = results.filter((r): r is ItemOutcome & { outcome: { ok: true } } & ItemOutcome => r.outcome.ok);
  const failed = results.filter((r) => !r.outcome.ok);
  if (answered.length === 0) {
    // Nobody answered: a check error as with one question, the items stay new.
    const first = failed[0]?.outcome as { ok: false; error: string; permanent?: boolean } | undefined;
    last.ok = false;
    last.error = `decision model: ${first?.error ?? 'no answer'}`;
    last.errorClass = first?.permanent ? 'permanent' : 'temporary';
    const streak = args.state.errorStreak + 1;
    const state: CheckState = { ...args.state, errorStreak: streak, last };
    // The history says so too: "each check that asked the model".
    const judged = `${results.length} item${results.length === 1 ? '' : 's'} (${results.map((r) => r.key).join(', ')}): no answer from the decision model, asked again next check — ${first?.error ?? 'no answer'}`;
    if (first?.permanent) return { state, judged, pause: { kind: 'error', reason: last.error } };
    if (streak >= limits.errorStreak) return { state, judged, pause: { kind: 'error', reason: `${streak} check errors in a row. Last: ${last.error}` } };
    return { state, judged };
  }
  const ok = answered.map((r) => ({ ...r, o: r.outcome as { ok: true; wake: boolean; question: string; value: number | string; detail?: string } }));
  const hits = ok.filter((r) => r.o.wake);
  const numbers = ok.map((r) => r.o.value).filter((v): v is number => typeof v === 'number');
  const best = hits[0]?.o.value ?? (numbers.length === ok.length ? Math.max(...numbers) : ok[0]!.o.value);
  const question = ok[0]!.o.question;
  const parts = [
    `${ok.length} item${ok.length === 1 ? '' : 's'} judged: ${ok.map((r) => short(r.o.value)).join(', ')}`,
    `${hits.length} above the wake rule`,
    ...(failed.length ? [`${failed.length} not answered, asked again next check`] : []),
    ...(more ? [`${more} more new item${more === 1 ? '' : 's'} next check`] : []),
  ];
  const rule = ok[0]!.o.detail;
  last.decision = { question, value: best, detail: `${parts.join('; ')}${rule ? ` (${rule})` : ''}` };
  if (failed.length) last.error = `decision model: ${(failed[0]!.outcome as { error: string }).error}`;
  const state: CheckState = {
    ...args.state,
    errorStreak: 0,
    last,
    seenItems: markSeen(args.state.seenItems, ok.map((r) => r.key), at),
    lastDecision: { at, ...last.decision },
  };
  // The history names each item with its answer, so a missing wake can
  // be traced to one mail (docs/sentinel.md, Troubleshooting).
  const each = results.map((r) => (r.outcome.ok ? `${r.key} ${short(r.outcome.value)}${r.outcome.wake ? ' (wakes)' : ''}` : `${r.key} no answer`));
  const judged = `${question}: ${each.join(', ')}; ${hits.length} above the wake rule${more ? `; ${more} more new item${more === 1 ? '' : 's'} next check` : ''}${hits.length ? ' — wakes' : ''}`;
  const pastDeadline = source.mode === 'once' && source.deadline !== undefined && now.getTime() >= new Date(source.deadline).getTime();
  if (hits.length) {
    return withWake({ state, judged, wake: { reason: 'decision', data: hits.map((h) => h.item) }, ...(source.mode === 'once' ? { complete: 'condition met' } : {}) }, now, limits);
  }
  if (pastDeadline) return withWake({ state, judged, wake: { reason: 'deadline', data: ok.map((r) => r.item) }, complete: 'deadline passed without the condition' }, now, limits);
  return { state, judged };
}
