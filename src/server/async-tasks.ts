// Process-wide store for fire-and-forget subagent tasks. spawn_subagent
// with wait:false enqueues a background runChatTurn promise here; the
// invoking agent gets a task_id back and can later check status /
// fetch result via subagent_status / subagent_result tools, or abort
// the whole spawn tree via subagent_cancel.
//
// Lifecycle: tasks are kept in memory for the server's lifetime. On
// process restart they're lost — sub-sessions persist in JSONL, but
// the in-memory task entries do not. Acceptable for v1; persistent
// async-task storage is on the FUTURE list if it becomes a pain.
//
// Attention wake (2026-07-28 feedback): a finished sub whose result
// nobody fetched used to sit unnoticed until the user happened to
// poke the parent agent. completeTask/failTask now schedule a wake
// turn on the parent (agent, session) — same mechanic as the tmux
// attention watcher — unless the spawn opted out (attention:false)
// or the parent already fetched the result via subagent_result.

import { triggerChatAbort } from './chat-aborts.ts';
import { logger } from './logger.ts';
import type { ChatTurnResult } from './run-turn-types.ts';

export type AsyncTaskState = 'running' | 'done' | 'failed' | 'cancelled';

export interface AsyncTaskEntry {
  task_id: string;
  state: AsyncTaskState;
  parent_agent: string;
  parent_session: string;
  target_agent: string;
  target_session: string;
  started_at: number;
  finished_at?: number;
  result?: ChatTurnResult;
  error?: string;
  /** Attention-wake opt-out recorded at spawn time (default: wake). */
  attention?: boolean;
  /** Set when subagent_result delivered the terminal state to the
   *  parent — suppresses the attention wake (nothing left to report). */
  result_fetched?: boolean;
}

const tasks = new Map<string, AsyncTaskEntry>();

export function newTaskId(): string {
  // Short, URL-safe, alphabet-only — easier to read in logs than a UUID.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `task_${ts}_${rnd}`;
}

export function registerTask(entry: Omit<AsyncTaskEntry, 'state'>): AsyncTaskEntry {
  const stored: AsyncTaskEntry = { ...entry, state: 'running' };
  tasks.set(entry.task_id, stored);
  return stored;
}

export function completeTask(task_id: string, result: ChatTurnResult): void {
  const e = tasks.get(task_id);
  if (!e) return;
  // Terminal states are final — a cancelled task whose runChatTurn
  // promise settles later must not flip back to done/failed.
  if (e.state !== 'running') return;
  e.state = result.error ? 'failed' : 'done';
  e.result = result;
  e.finished_at = Date.now();
  if (result.error) e.error = result.error;
  scheduleAttentionWake(e);
}

export function failTask(task_id: string, error: string): void {
  const e = tasks.get(task_id);
  if (!e) return;
  if (e.state !== 'running') return;
  e.state = 'failed';
  e.error = error;
  e.finished_at = Date.now();
  scheduleAttentionWake(e);
}

export function getTask(task_id: string): AsyncTaskEntry | undefined {
  return tasks.get(task_id);
}

export function listTasksForAgent(parent_agent: string): AsyncTaskEntry[] {
  return [...tasks.values()].filter((t) => t.parent_agent === parent_agent);
}

/** Children of a given sub: tasks spawned FROM the sub's own session.
 *  (A sub that spawns records itself as the parent, with its sub-
 *  session as parent_session.) */
export function listChildTasks(agent: string, session: string): AsyncTaskEntry[] {
  return [...tasks.values()].filter(
    (t) => t.parent_agent === agent && t.parent_session === session,
  );
}

/** Mark that the parent received the terminal state via
 *  subagent_result — suppresses the pending attention wake. */
export function markResultFetched(task_id: string): void {
  const e = tasks.get(task_id);
  if (e) e.result_fetched = true;
}

// ── cancel ────────────────────────────────────────────────────────────

export interface CancelOutcome {
  /** Tasks moved running → cancelled (includes cascaded children). */
  cancelled: string[];
  /** Tasks already terminal when reached (skipped, state noted). */
  skipped: Array<{ task_id: string; state: AsyncTaskState }>;
}

/**
 * Cancel a running sub-task AND its descendants (a sub that spawned
 * its own subs — 2026-07-28 report: one orchestrator sub occupied all
 * four slots via 3 children and there was no way back short of a
 * server restart).
 *
 * Mechanics per task: mark the registry entry 'cancelled' FIRST (so
 * the settling runChatTurn promise can't overwrite the state), then
 * trigger the chat-abort signal for the sub's (agent, session) — the
 * same signal the Stop button uses, honored by all engine adapters.
 * Disk artifacts the sub produced stay untouched (append-only work is
 * valuable; deliberate decision from the report's open question).
 *
 * Cascade walks the registry tree breadth-first. Sync (wait:true)
 * grand-children are not registry-visible and are NOT reached — their
 * parent's abort ends the turn that was awaiting them.
 */
export function cancelTaskCascade(task_id: string, reason: string): CancelOutcome | null {
  const root = tasks.get(task_id);
  if (!root) return null;
  const outcome: CancelOutcome = { cancelled: [], skipped: [] };
  const queue: AsyncTaskEntry[] = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const e = queue.shift()!;
    if (seen.has(e.task_id)) continue;
    seen.add(e.task_id);
    // Children first into the queue regardless of e's own state — a
    // failed orchestrator can still have live children.
    queue.push(...listChildTasks(e.target_agent, e.target_session));
    if (e.state !== 'running') {
      outcome.skipped.push({ task_id: e.task_id, state: e.state });
      continue;
    }
    e.state = 'cancelled';
    e.error = reason;
    e.finished_at = Date.now();
    const abort = triggerChatAbort(e.target_agent, e.target_session);
    logger.info({
      msg: 'subagent.cancelled',
      task_id: e.task_id,
      target_agent: e.target_agent,
      target_session: e.target_session,
      abort_delivered: abort.aborted,
      reason,
    });
    outcome.cancelled.push(e.task_id);
  }
  return outcome;
}

/**
 * Resolve when the task leaves the 'running' state — completes (done,
 * failed or cancelled). Caps at `timeoutMs`; on timeout returns the
 * entry as-is (state still 'running'). Cheap polling (200 ms interval)
 * inside the server, no extra LLM round-trips for the caller — the
 * calling tool just awaits and the orchestrator agent's turn doesn't
 * burn rounds polling.
 */
export async function waitForTaskCompletion(
  task_id: string,
  timeoutMs: number,
): Promise<AsyncTaskEntry | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = tasks.get(task_id);
    if (!e) return null;
    if (e.state !== 'running') return e;
    await new Promise((r) => setTimeout(r, 200));
  }
  return tasks.get(task_id) ?? null;
}

// ── attention wake ────────────────────────────────────────────────────

/** Injected at server boot (configureSubagentAttention). The wake runs
 *  runChatTurn on the PARENT's session, so it needs the same deps +
 *  SSE publisher wiring as the tmux attention watcher
 *  (feedback_publishsse_must_broadcast: without publish, an open web
 *  client sees the wake turn only after a hard refresh). */
interface AttentionDeps {
  dispatchWakeTurn: (args: {
    agent: string;
    session: string;
    text: string;
  }) => Promise<void>;
  /** Grace period before the wake check — a parent blocking in
   *  wait_until_done fetches within ~200ms; don't wake for that. */
  graceMs: number;
}

let attentionDeps: AttentionDeps | null = null;

export function configureSubagentAttention(deps: AttentionDeps): void {
  attentionDeps = deps;
}

function wakePrompt(e: AsyncTaskEntry): string {
  const head = (e.result?.finalText ?? e.error ?? '').replace(/\s+/g, ' ').slice(0, 160);
  // Artifacts are the tool's word, not the model's — name them here so
  // a sub whose final text degraded still hands over what it made.
  const media = e.result?.media ?? [];
  const mediaLine =
    media.length > 0
      ? ` Generated media (${media.length}): ${media.map((m) => m.path).join(', ')}.`
      : '';
  return (
    `[subagent attention] Task '${e.task_id}' (sub-agent '${e.target_agent}', session ` +
    `'${e.target_session}') finished with state '${e.state}'.` +
    (head ? ` First line: "${head}"` : '') +
    mediaLine +
    `\nFetch the full answer with subagent_result({ task_id: "${e.task_id}" }), then continue ` +
    `whatever depended on it (validate, report to the user, or chain the next step). If nothing ` +
    `depends on it, a short acknowledgement to the user is enough.`
  );
}

/**
 * Wake the parent agent when a sub finishes (2026-07-28 feedback,
 * explicitly requested by Rene). Fires AFTER `graceMs` and only when:
 *   - the server wired attention deps (main process only),
 *   - the spawn didn't opt out (attention !== false),
 *   - the state is done/failed (cancelled = the canceller already knows),
 *   - the parent has not fetched the result in the meantime,
 *   - the parent session is a real session (not '?').
 * The wake turn queues on the parent's session lock, so a busy parent
 * handles it right after its current turn — no interruption.
 */
function scheduleAttentionWake(e: AsyncTaskEntry): void {
  const deps = attentionDeps;
  if (!deps) return;
  if (e.attention === false) return;
  if (e.state !== 'done' && e.state !== 'failed') return;
  if (!e.parent_session || e.parent_session === '?') return;
  const timer = setTimeout(() => {
    const fresh = tasks.get(e.task_id);
    if (!fresh || fresh.result_fetched) return;
    logger.info({
      msg: 'subagent.attention_wake',
      task_id: e.task_id,
      parent_agent: e.parent_agent,
      parent_session: e.parent_session,
      state: fresh.state,
    });
    void deps
      .dispatchWakeTurn({
        agent: e.parent_agent,
        session: e.parent_session,
        text: wakePrompt(fresh),
      })
      .catch((err: unknown) => {
        logger.warn({
          msg: 'subagent.attention_wake_failed',
          task_id: e.task_id,
          err: (err as Error).message,
        });
      });
  }, deps.graceMs);
  // Never keep the process alive for a pending wake.
  timer.unref?.();
}
