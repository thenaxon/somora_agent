// Sentinel — Trigger Runtime for somora.
//
// Trigger model: Source -> Evaluator -> Dispatch.
//   - Source emits events (time-tick, http-fetch result, exec-output, etc.)
//   - Evaluator decides whether THIS event should actually fire the trigger
//   - Dispatch describes what happens when it fires (in Phase 1: always an
//     agent system-turn through /spawn-async)
//
// Phase 1 ships time-source + agent-turn dispatch + the surrounding
// infrastructure (storage, scheduler, tool, web-UI, HTTP routes). Phase 2
// adds http_json + exec sources + expression/regex evaluators.

import type { TmuxSessionKind } from '../tmux/origin-store.ts';

// Marker type carried through but not used by Sentinel itself — kept here
// so the broader somora type tree imports cleanly.
export type { TmuxSessionKind };

// ─────────────────────────────────────────────────────────────────────
// Source
// ─────────────────────────────────────────────────────────────────────

/** Time-source variants. Pick one based on the cadence vocabulary the
 *  user (or the agent) speaks: absolute one-shot, fixed-interval, or
 *  one of the human-friendly recurring patterns. Cron is the escape
 *  hatch for power users. */
export type TimeSpec =
  | { type: 'at'; iso: string }                            // 2026-05-18T10:00:00+02:00
  | { type: 'every'; interval: string }                    // "5m", "30s", "1h"
  | { type: 'daily'; time: string }                        // "08:00" or "08:00:30"
  | { type: 'weekly'; day: WeekDay; time: string }         // "mon" @ "09:00"
  | { type: 'cron'; expression: string };                  // standard 5-field cron

export type WeekDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type Source =
  | { type: 'time'; spec: TimeSpec };

// Phase 2+ will add: { type: 'http_json'; url; interval; jsonPath?; method?; headers? }
// Phase 2+ will add: { type: 'exec'; command; cwd?; interval; outputAs: 'json'|'exit_code'|'stdout' }
// Phase 3+ will add: { type: 'webhook'; pathSuffix } — POST /sentinel/webhook/<pathSuffix>

// ─────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────

/** Phase 1 ships `none` only (time-source events always fire). Phase 2
 *  adds the other variants. Kept as a discriminated union so the
 *  pluggable handler-map pattern works from day one — adding a new
 *  evaluator later is a new branch + a new handler, no breaking
 *  change to existing triggers. */
export type Evaluator =
  | { type: 'none' };

// Phase 2+: { type: 'expression'; expression: string }
// Phase 2+: { type: 'regex'; pattern: string; flags?: string }
// Phase 2+: { type: 'exit_code'; equals?: number; not?: number }
// Phase 3+: { type: 'composite'; op: 'and'|'or'; children: Evaluator[] }
// Future:   { type: 'llm'; model: string; prompt: string; threshold?: number }

// ─────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────

/** Phase 1: single dispatch shape — wake an agent in a specific session
 *  with a system-prompted turn. The dispatcher prepends a structured
 *  evidence block to the user-supplied prompt so the agent knows it
 *  was woken by sentinel, not by a real user. */
export interface Dispatch {
  /** Target agent (must exist under ~/.somora/agents/<agent>/). */
  agent: string;
  /** Target chat session — slug or 'main'. If the session doesn't
   *  exist yet, sentinel auto-creates it via /spawn-async's resolution
   *  logic (Phase 0 fix). Default: 'main'. */
  session: string;
  /** The prompt the agent receives. Treated as the user-message body;
   *  sentinel prepends an [Sentinel trigger fired] header with all
   *  evidence so the agent has full context. */
  prompt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────

/** Cooldown / dedupe / rising-edge behavior. Phase 1 honors cooldownMs
 *  + maxFiresPerDay + missedFiresPolicy; the rising-edge flag is
 *  recorded but only acts on value-bearing sources (Phase 2+). */
export interface Policy {
  /** Minimum ms between fires. Default 0 (= every event fires).
   *  Sentinel enforces a global floor of 60_000ms (1 min) so no agent
   *  can configure sub-minute spam. */
  cooldownMs?: number;
  /** Hard daily cap on fires per trigger. Default 500. Triggers that
   *  exceed this auto-pause with reason 'daily_cap'. */
  maxFiresPerDay?: number;
  /** How to handle a recurring trigger whose fire-time(s) elapsed
   *  while somora was down. Default `skip`. One-shot `at`-triggers
   *  use the boot-grace window (CATCHUP_GRACE_MS) regardless of this
   *  setting; this flag only changes behavior for recurring sources.
   *    - `skip` (default): don't backfill. Recompute next future
   *      fire and arm normally. Best for "check meine mails 8:00"
   *      where you don't want 14 stacked emails after a 2-week
   *      outage.
   *    - `catchUpOnce`: fire ONCE with `catchUp:true` in the
   *      evidence block, then proceed with the normal schedule. Best
   *      for "monthly summary" where you want to know the period was
   *      missed but not get N separate fires.
   *    - `catchUpAll`: fire ONCE per missed scheduled instant (caps
   *      at MAX_BACKFILL_FIRES = 24 to avoid runaway). Best for log-
   *      style triggers where each instant carries unique context. */
  missedFiresPolicy?: 'skip' | 'catchUpOnce' | 'catchUpAll';
  /** Phase 2+ — only fire on the value transition (false→true), not
   *  on every poll that sees true. Currently a no-op for time-source. */
  fireOn?: 'every' | 'rising_edge';
}

// ─────────────────────────────────────────────────────────────────────
// Trigger (the persisted entity)
// ─────────────────────────────────────────────────────────────────────

export type TriggerStatus = 'active' | 'paused' | 'error' | 'completed';

export interface Trigger {
  /** Stable id. Auto-generated as `<slug-of-name>-<random4>` at creation. */
  id: string;
  /** Human label. Shown in lists, mentioned in evidence-block. */
  name: string;
  /** Short description of intent — what the user wanted when they set
   *  this up. Echoed in the agent's evidence block so the agent
   *  understands the why, not just the what. */
  intent?: string;
  /** Which agent created this. Used for "show my triggers" filters. */
  ownerAgent: string;
  /** Source of events. */
  source: Source;
  /** Decides whether each event fires. */
  evaluator: Evaluator;
  /** What happens on fire. */
  dispatch: Dispatch;
  /** Cooldown / cap behavior. */
  policy?: Policy;
  /** When this trigger was created (ISO). */
  createdAt: string;
  /** Lifecycle status. `active` is the default; `paused` is user-set;
   *  `error` is set by the scheduler after `errorStreakThreshold` (3)
   *  consecutive failed fires; `completed` is set for one-shot `at`
   *  triggers after they've fired (if catch-up policy didn't keep
   *  them re-firing). */
  status: TriggerStatus;
  /** Why the trigger is in its current state. Set when status flips
   *  to `error` or `paused`, cleared when it goes back to `active`. */
  statusReason?: string;
  /** Per-trigger fire bookkeeping. */
  fireCount: number;
  /** ISO of last fire (any outcome). */
  lastFireAt?: string;
  /** ISO of last successful fire. */
  lastSuccessAt?: string;
  /** ISO of last failed fire. */
  lastErrorAt?: string;
  /** Count of consecutive failed fires (resets to 0 on success).
   *  When this reaches errorStreakThreshold, status → 'error'. */
  errorStreak: number;
  /** Computed next-fire time. Updated by the scheduler after each
   *  fire and at boot recovery. ISO timestamp. */
  nextFireAt?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Fire history entry
// ─────────────────────────────────────────────────────────────────────

export interface FireHistoryEntry {
  /** ISO of fire. */
  firedAt: string;
  /** Trigger snapshot's nextFireAt at fire-time — for "was this catch-up?". */
  scheduledFor: string;
  /** Outcome of the dispatch. */
  outcome: 'success' | 'error' | 'skipped';
  /** When skipped, why (cooldown / paused-during-fire / daily-cap). */
  skipReason?: string;
  /** When error, error message. */
  error?: string;
  /** When success, the task_id from /spawn-async (for traceback). */
  taskId?: string;
  /** Was this a missed-fire caught up on restart? */
  catchUp?: boolean;
  /** Was this triggered via 'test-now' (bypasses cooldown/dedupe)? */
  testMode?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Defaults / limits (the safeguards we promised the user)
// ─────────────────────────────────────────────────────────────────────

export const SENTINEL_LIMITS = {
  /** Global minimum interval. No "every 5s" possible. */
  MIN_INTERVAL_MS: 60_000,
  /** Max active triggers per agent. */
  MAX_TRIGGERS_PER_AGENT: 50,
  /** Max fires per trigger per UTC day. */
  MAX_FIRES_PER_DAY: 500,
  /** Consecutive failures before auto-pause via status='error'. */
  ERROR_STREAK_THRESHOLD: 3,
  /** Max history rows kept per trigger (older rotated out). */
  HISTORY_RING_SIZE: 200,
  /** Catch-up grace: if a one-shot `at` trigger missed its fire by
   *  more than this, mark completed without firing. */
  CATCHUP_GRACE_MS: 6 * 60 * 60 * 1000, // 6 hours
  /** Hard ceiling on backfill fires per trigger at boot, even when
   *  `missedFiresPolicy: 'catchUpAll'` is set. Protects against a
   *  trigger that's been "every 5m" with somora down for a month
   *  spawning 8000 fires on next boot. */
  MAX_BACKFILL_FIRES: 24,
} as const;
