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
  /** When the origin last handed the agent a task (prompt submitted):
   *  the task's start, before the watcher's next look sees it working. */
  promptedAt?: number;
  /** The last new_conversation, start and end: the agent working on
   *  its /new is not a task. */
  resetFrom?: number;
  resetTo?: number;
}

/** What a tool call adds to the ledger besides "looked at it". */
export type ObservationExtra = Pick<ObservationRecord, 'promptedAt' | 'resetFrom' | 'resetTo'>;

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
  extra?: ObservationExtra,
): void {
  try {
    const map = readJsonFile<ObservationMap>(OBSERVATIONS_PATH) ?? {};
    const prev = map[name];
    map[name] = {
      lastObservedAt: Date.now(),
      agent,
      ...(session ? { session } : {}),
      ...(sawState ? { sawState } : {}),
      // Task marks stay until replaced: a later look must not erase them.
      ...(prev?.promptedAt ? { promptedAt: prev.promptedAt } : {}),
      ...(prev?.resetFrom ? { resetFrom: prev.resetFrom } : {}),
      ...(prev?.resetTo ? { resetTo: prev.resetTo } : {}),
      ...(extra ?? {}),
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
  /** While blocked: the detection rule that matched (permission_required …). */
  rule?: string | null;
  /** When the last task ended (idle again), or a prompt was found spent. */
  task_ended_at?: number | null;
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

/** A prompt is spent when the agent is seen idle this long after it
 *  without having been seen at work: its task ran between two looks. A
 *  fresh prompt the agent has not started on yet stays usable. */
const PROMPT_SPENT_MS = 10_000;

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
  /** When the last task ended (ready again); a prompt sent before it
   *  belongs to that task. */
  taskEndedAt: number | null;
  /** While blocked: the detection rule that matched. */
  blockedRule: string | null;
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
    taskEndedAt: null,
    blockedRule: null,
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
  /** The detection rule that matched, when there is one. */
  rule?: string | null;
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
  s.blockedRule = effective === 'blocked' ? (input.rule ?? null) : null;

  if (s.lastState === null) {
    // Baseline tick — record what we see, fire nothing.
    s.lastState = effective;
    s.seenRunning = effective === 'running';
    if (effective === 'running') s.lastRunningSeenAt = now;
    if (effective !== 'ready') {
      // Since the prompt that handed it over (sent just before the
      // watcher first looked), else at least since now.
      const p = observation?.promptedAt;
      const beforeReset = p !== undefined && observation?.resetFrom !== undefined && p < observation.resetFrom;
      s.taskStartedAt = p && p <= now && now - p < 60_000 && !beforeReset ? p : now;
    }
    if (effective !== 'blocked') s.lastNotBlockedSeenAt = now;
    return { state: s, action };
  }

  // Task timing: a task runs from the first look that is not ready (at
  // work or at a dialog) until ready again — or from the moment it was
  // handed over, when that came after the last task ended (the look
  // lags the prompt by up to one poll).
  // A prompt whose task began and ended between two looks (idle seen
  // again well after it) is spent: it must not start a later task.
  const p0 = observation?.promptedAt;
  if (effective === 'ready' && s.taskStartedAt === null && p0 && now - p0 > PROMPT_SPENT_MS && p0 > (s.taskEndedAt ?? 0)) {
    s.taskEndedAt = p0;
  }
  if (effective !== 'ready' && s.taskStartedAt === null) {
    const p = observation?.promptedAt;
    // A prompt from before the latest /new belongs to an earlier task.
    const beforeReset = p !== undefined && observation?.resetFrom !== undefined && p < observation.resetFrom;
    s.taskStartedAt = p && p <= now && p > (s.taskEndedAt ?? 0) && !beforeReset ? p : now;
  }
  if (effective === 'ready' && s.lastState !== 'ready' && s.taskStartedAt !== null) {
    s.lastTaskMs = taskLengthOf(s.taskStartedAt, now, observation, s.lastTaskMs);
    s.taskStartedAt = null;
    s.taskEndedAt = now;
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
    rule: s.blockedRule,
    task_ended_at: s.taskEndedAt,
  };
}

/** How long a finished task took. The agent's own /new (new_conversation)
 *  is no task: a run that began within it keeps the previous length —
 *  unless a prompt followed the /new before the watcher saw it idle,
 *  then the task ran from that prompt. */
function taskLengthOf(start: number, end: number, obs: ObservationRecord | null, previous: number | null): number | null {
  const from = obs?.resetFrom;
  const to = obs?.resetTo;
  // The watcher sees a run up to one poll late: a start shortly after
  // the reset began still belongs to it.
  const inReset = from !== undefined && start >= from - 1_000 && start <= (to ?? end);
  if (!inReset) return end - start;
  const p = obs?.promptedAt;
  if (p && to !== undefined && p >= to && p <= end) return end - p;
  return previous;
}
