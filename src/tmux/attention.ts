// tmux attention — state machine + cross-process ledger files.
//
// Design: private/tmux-hooks-design.md (Phase 1, watcher-first).
// The watcher (attention-watcher.ts, main server only) polls somora-
// created coding-CLI tmux sessions, feeds each capture through the
// PURE step function below and acts on the returned action. The two
// JSON files exist because tmux TOOL calls run in the MCP child
// process for claude-cli/codex engines while the watcher lives in the
// main server — disk is the shared source of truth (same pattern as
// sentinel, see feedback_stateful_tools_cross_process):
//
//   tmux-observations.json  — written by the TOOL layer (any process)
//                             whenever the ORIGIN agent looks at a
//                             session (capture / wait_idle / send).
//                             Read by the watcher: "did the agent see
//                             the completion itself?"
//   tmux-attention.json     — written ONLY by the watcher (single
//                             writer, no clobber risk). Read by the
//                             tool layer to surface attention metadata
//                             in list/capture/wait_idle responses and
//                             by the web tmux list for the badge.
//
// Anti-double-trigger contract (the operator, 2026-07-27): if the origin agent
// observed the running→ready transition itself (its wait_idle returned
// it, or it captured after the event), NO wake fires. A wake only goes
// out when the agent's turn ended without having seen the completion.
// One wake per completion — an ignored wake is never repeated; the
// session re-arms only after the origin agent interacts with it again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SOMORA_HOME_DIR } from '../server/logger.ts';
/** A pane's state as the watcher and the ledger speak of it, from the
 *  agent state (detection/): working → running, idle → ready, blocked
 *  (a dialog waits for an answer), unknown (the screen says nothing —
 *  e.g. a transcript viewer; the previous state stands). */
export type PaneState = 'running' | 'ready' | 'blocked' | 'unknown';
/** What an observation saw; unknown proves nothing. */
export type SeenState = 'running' | 'ready' | 'blocked';

export function paneStateOf(agentState: 'idle' | 'working' | 'blocked' | 'unknown'): PaneState {
  return agentState === 'idle' ? 'ready' : agentState === 'working' ? 'running' : agentState;
}

const OBSERVATIONS_PATH = join(SOMORA_HOME_DIR, 'tmux-observations.json');
const ATTENTION_PATH = join(SOMORA_HOME_DIR, 'tmux-attention.json');
/** Hygiene bound — both files are keyed by tmux session name; stale
 *  entries for long-dead sessions get dropped past this count. */
const MAX_ENTRIES = 200;

// ── observation ledger (tool layer writes, watcher reads) ────────────

export interface ObservationRecord {
  /** Epoch ms of the most recent look at the pane by the ORIGIN
   *  (agent, session) — capture, wait_idle end, or send. */
  lastObservedAt: number;
  agent: string;
  session?: string;
  /** TUI state the origin SAW at that moment (from the tool's own
   *  detectTuiState). Crucial for suppress-correctness: only a look
   *  that saw 'ready' proves the agent learned of the completion —
   *  a capture that still showed 'running' must not suppress, and
   *  the timestamps alone can't tell (the watcher's event detection
   *  lags the agent's own wait_idle by up to one poll interval).
   *  Undefined for send (typing proves driving, not knowing). */
  sawState?: SeenState;
}

type ObservationMap = Record<string, ObservationRecord>;

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function pruneOldest<T extends { lastObservedAt?: number; lastEventAt?: number | null }>(
  map: Record<string, T>,
): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return map;
  const byAge = keys.sort(
    (a, b) =>
      (map[a]?.lastObservedAt ?? map[a]?.lastEventAt ?? 0) -
      (map[b]?.lastObservedAt ?? map[b]?.lastEventAt ?? 0),
  );
  for (const k of byAge.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
  return map;
}

/** Record that (agent, session) just looked at tmux session `name`.
 *  Called from the tmux tool layer; read-modify-write with last-writer-
 *  wins — call rate is a few per minute at most, a lost race costs at
 *  worst one spurious wake. Never throws (best-effort ledger). */
export function recordTmuxObservation(
  name: string,
  agent: string,
  session?: string,
  sawState?: SeenState,
): void {
  try {
    const map = readJsonFile<ObservationMap>(OBSERVATIONS_PATH) ?? {};
    map[name] = {
      lastObservedAt: Date.now(),
      agent,
      ...(session ? { session } : {}),
      ...(sawState ? { sawState } : {}),
    };
    writeJsonFile(OBSERVATIONS_PATH, pruneOldest(map));
  } catch {
    /* ledger is best-effort — a failed write must never break the tool */
  }
}

export function readTmuxObservations(): ObservationMap {
  return readJsonFile<ObservationMap>(OBSERVATIONS_PATH) ?? {};
}

// ── attention mirror (watcher writes, tool layer/web read) ───────────

export interface AttentionDisplay {
  /** True from the became_ready event until the origin agent looks at
   *  the session (or the event was woken + inspected). Drives the web
   *  badge and the attention block in tool responses. */
  needs_attention: boolean;
  last_event_at: number | null;
  last_wake_at: number | null;
  wakes_today: number;
  /** Last state the watcher saw: running, ready, or blocked (a dialog
   *  waits for an answer). */
  state: 'running' | 'ready' | 'blocked' | null;
  /** When the current task started (the agent went from ready to
   *  running), while it is not ready again; null otherwise. A dialog in
   *  between belongs to the task. */
  task_started_at?: number | null;
  /** How long the last finished task took, start to ready, in ms. */
  last_task_ms?: number | null;
}

type AttentionMap = Record<string, AttentionDisplay>;

export function writeAttentionMirror(map: AttentionMap): void {
  try {
    writeJsonFile(ATTENTION_PATH, map);
  } catch {
    /* display mirror is best-effort */
  }
}

export function readAttentionMirror(): AttentionMap {
  return readJsonFile<AttentionMap>(ATTENTION_PATH) ?? {};
}

// ── pure state machine ────────────────────────────────────────────────

export interface AttentionSessionState {
  /** Last state seen by the watcher. null until the first look — the
   *  first tick only sets a baseline and never fires an event (prevents
   *  a wake salvo over sessions that were already idle or waiting at a
   *  dialog when the server booted). */
  lastState: 'running' | 'ready' | 'blocked' | null;
  /** When the watcher last saw the pane NOT blocked. Anchor for the
   *  suppress rule of a blocked event, as lastRunningSeenAt is for a
   *  completion. */
  lastNotBlockedSeenAt: number | null;
  /** When the watcher last saw the pane running. Anchor for the
   *  suppress rule: an origin observation with sawState 'ready' at or
   *  after this moment proves the agent saw THIS run's completion
   *  (the watcher's own event detection lags by up to one poll). */
  lastRunningSeenAt: number | null;
  /** An event needs a PRIOR observed running phase — a session that is
   *  ready from the first sighting has nothing "completed". */
  seenRunning: boolean;
  /** Set on the running→ready transition; cleared by observation,
   *  wake, cap, or a new running phase (moment passed). */
  pending: { eventAt: number; reason: 'ready' | 'blocked' } | null;
  lastWakeAt: number | null;
  /** UTC day (YYYY-MM-DD) `wakesToday` counts for. */
  wakeDay: string;
  wakesToday: number;
  /** True after a wake until the origin agent interacts with the
   *  session again — an ignored wake is never repeated. */
  disarmed: boolean;
  /** Display flag (see AttentionDisplay.needs_attention). */
  needsAttention: boolean;
  lastEventAt: number | null;
  /** When the current task started (left ready); null when ready. */
  taskStartedAt: number | null;
  /** Duration of the last finished task (start → ready), in ms. */
  lastTaskMs: number | null;
}

export function initialAttentionState(): AttentionSessionState {
  return {
    lastState: null,
    lastNotBlockedSeenAt: null,
    lastRunningSeenAt: null,
    seenRunning: false,
    pending: null,
    lastWakeAt: null,
    wakeDay: '',
    wakesToday: 0,
    disarmed: false,
    needsAttention: false,
    lastEventAt: null,
    taskStartedAt: null,
    lastTaskMs: null,
  };
}

export type AttentionAction =
  | { kind: 'none' }
  | { kind: 'event' } // became_ready detected this tick (pending set)
  | { kind: 'observed' } // origin saw it itself — suppressed, no wake
  | { kind: 'wake'; reason: 'ready' | 'blocked' }
  | { kind: 'cap_reached' };

export interface AttentionStepInput {
  state: AttentionSessionState;
  /** The pane's state this tick (paneStateOf the detected agent state). */
  tuiState: PaneState;
  now: number;
  /** Observation-ledger record for this tmux session, if any. */
  observation: ObservationRecord | null;
  origin: { agent: string; session?: string };
  /** True while the origin (agent, session) holds an active turn. */
  originBusy: boolean;
  config: { wake: boolean; cooldownS: number; dailyCapPerSession: number };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Does the ledger record count as "the origin looked"? Agent must
 *  match; session must match only when BOTH sides carry one (MCP
 *  children don't always know their somora session id). */
function observationMatchesOrigin(
  obs: ObservationRecord,
  origin: { agent: string; session?: string },
): boolean {
  if (obs.agent !== origin.agent) return false;
  if (obs.session && origin.session && obs.session !== origin.session) return false;
  return true;
}

/**
 * One watcher tick for one session. Pure — no IO, no clock reads.
 * Returns the next state plus the action the caller must perform.
 * Only ONE action is returned per tick; precedence: observation-
 * clearing beats waking (same-tick observation suppresses the wake).
 */
export function stepAttention(input: AttentionStepInput): {
  state: AttentionSessionState;
  action: AttentionAction;
} {
  const { tuiState, now, observation, origin, originBusy, config } = input;
  const s: AttentionSessionState = { ...input.state };
  let action: AttentionAction = { kind: 'none' };

  // unknown: the screen says nothing — keep what was there.
  if (tuiState === 'unknown') return { state: s, action };
  const effective: 'running' | 'ready' | 'blocked' = tuiState;

  if (s.lastState === null) {
    // Baseline tick — record what we see, fire nothing.
    s.lastState = effective;
    s.seenRunning = effective === 'running';
    if (effective === 'running') s.lastRunningSeenAt = now;
    if (effective !== 'ready') s.taskStartedAt = now; // at least since now
    if (effective !== 'blocked') s.lastNotBlockedSeenAt = now;
    return { state: s, action };
  }

  // Task timing: a task runs from the first look that is not ready (at
  // work or at a dialog) until ready again.
  if (effective !== 'ready' && s.taskStartedAt === null) s.taskStartedAt = now;
  if (effective === 'ready' && s.lastState !== 'ready' && s.taskStartedAt !== null) {
    s.lastTaskMs = now - s.taskStartedAt;
    s.taskStartedAt = null;
  }

  if (effective !== 'blocked') s.lastNotBlockedSeenAt = now;
  if (effective === 'running') {
    s.seenRunning = true;
    s.lastRunningSeenAt = now;
    if (s.pending) {
      // A new run started before the previous event was handled — that
      // moment has passed; the next edge fires again.
      s.pending = null;
    }
  } else if (effective === 'blocked' && s.lastState !== 'blocked' && !s.disarmed) {
    // A dialog waits for an answer: wake, the origin has to decide.
    s.pending = { eventAt: now, reason: 'blocked' };
    s.needsAttention = true;
    s.lastEventAt = now;
    action = { kind: 'event' };
  } else if (effective === 'ready' && s.lastState !== 'ready' && s.seenRunning && !s.disarmed) {
    // Finished (from running, or from a dialog answered elsewhere).
    s.pending = { eventAt: now, reason: 'ready' };
    s.needsAttention = true;
    s.lastEventAt = now;
    action = { kind: 'event' };
  } else if (effective === 'ready' && s.pending?.reason === 'blocked') {
    // The dialog went away without us — nothing left to answer.
    s.pending = null;
    s.needsAttention = false;
  }
  s.lastState = effective;

  // Observation bookkeeping — runs every tick, before any wake
  // decision, so a same-tick look by the origin suppresses the wake.
  //
  // Suppress rule: the origin must have SEEN 'ready' at or after the
  // watcher's last running-sighting. Comparing against the watcher's
  // own eventAt would be wrong — the agent's wait_idle typically sees
  // the completion up to one poll interval BEFORE the watcher's
  // transition tick, and that look must still count.
  const obs = observation && observationMatchesOrigin(observation, origin) ? observation : null;
  // A blocked event counts as seen when the origin saw the dialog after
  // the pane was last not blocked.
  const sawCompletion =
    obs !== null &&
    (s.pending?.reason === 'blocked' || (!s.pending && s.lastState === 'blocked')
      ? obs.sawState === 'blocked' && obs.lastObservedAt >= (s.lastNotBlockedSeenAt ?? 0)
      : obs.sawState === 'ready' && obs.lastObservedAt >= (s.lastRunningSeenAt ?? 0));
  if (obs) {
    if (s.disarmed && s.lastWakeAt !== null && obs.lastObservedAt > s.lastWakeAt) {
      s.disarmed = false; // origin came back to the session — re-arm
    }
    if (s.pending && sawCompletion) {
      s.pending = null;
      s.needsAttention = false;
      return { state: s, action: { kind: 'observed' } };
    }
    if (!s.pending && s.needsAttention && sawCompletion) {
      s.needsAttention = false; // capped/flag-only attention got looked at
    }
  }

  if (!s.pending) return { state: s, action };

  // Wake decision.
  if (originBusy) return { state: s, action }; // defer — recheck next tick
  if (!config.wake) {
    // Events-only mode: keep the flag, drop the pending wake.
    s.pending = null;
    return { state: s, action };
  }
  if (s.lastWakeAt !== null && now - s.lastWakeAt < config.cooldownS * 1000) {
    return { state: s, action }; // cooldown — keep pending, retry next tick
  }
  const day = utcDay(now);
  if (s.wakeDay !== day) {
    s.wakeDay = day;
    s.wakesToday = 0;
  }
  if (s.wakesToday >= config.dailyCapPerSession) {
    s.pending = null; // flag stays; no more turns today
    return { state: s, action: { kind: 'cap_reached' } };
  }
  const reason = s.pending.reason;
  s.pending = null;
  s.lastWakeAt = now;
  s.wakesToday += 1;
  s.disarmed = true;
  // needsAttention stays true until the (woken) agent actually looks.
  return { state: s, action: { kind: 'wake', reason } };
}

/** Project internal state onto the display shape for the mirror file. */
export function toDisplay(s: AttentionSessionState): AttentionDisplay {
  return {
    needs_attention: s.needsAttention,
    last_event_at: s.lastEventAt,
    last_wake_at: s.lastWakeAt,
    wakes_today: s.wakesToday,
    state: s.lastState,
    task_started_at: s.taskStartedAt,
    last_task_ms: s.lastTaskMs,
  };
}
