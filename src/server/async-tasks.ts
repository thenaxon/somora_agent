// Sub-agent task registry — since 2026-09-13 a VIEW over the work
// ledger (work-ledger.ts). spawn_subagent with wait:false, the
// /spawn-* routes, subagent_status/result/list/cancel and the
// async-tasks test read these functions and shapes; they stay
// byte-compatible while the state lives in one book with the
// agent_ask calls and the voice consults.
//
// Sentinel fires register here too (parent_agent 'sentinel'); the
// ledger keeps them as their own kind and never wakes anyone for them.
//
// Lifecycle: tasks are kept in memory for the server's lifetime. On
// restart they're lost — sub-sessions persist in JSONL, the entries
// do not.

import type { ChatTurnResult } from './run-turn-types.ts';
import {
  cancelWork,
  configureWorkWake,
  failWork,
  finishWork,
  getWork,
  listWork,
  markFetched,
  openWork,
  waitForWork,
  type WorkItem,
} from './work-ledger.ts';

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
  /** Nesting depth of the PARENT (0 = a top-level agent spawned this). */
  parent_depth?: number;
}

const TASK_KINDS: Array<WorkItem['origin']['kind']> = ['subagent', 'sentinel'];

function toEntry(it: WorkItem): AsyncTaskEntry {
  const r = it.requester;
  const parent = r && 'agent' in r ? r : { agent: '?', session: '?' };
  const state: AsyncTaskState =
    it.state === 'queued' || it.state === 'running' ? 'running' : it.state === 'done' ? 'done' : it.state === 'failed' ? 'failed' : 'cancelled';
  return {
    task_id: it.id,
    state,
    parent_agent: parent.agent,
    parent_session: parent.session,
    target_agent: it.target.agent,
    target_session: it.target.session,
    started_at: it.enqueuedAt,
    ...(it.finishedAt !== undefined ? { finished_at: it.finishedAt } : {}),
    ...(it.result ? { result: it.result } : {}),
    ...(it.error ? { error: it.error } : {}),
    ...(it.wake === 'never' && it.origin.kind === 'subagent' ? { attention: false } : {}),
    ...(it.resultFetched ? { result_fetched: true } : {}),
    ...(it.parentDepth !== undefined ? { parent_depth: it.parentDepth } : {}),
  };
}

export function newTaskId(): string {
  // Short, URL-safe, alphabet-only — easier to read in logs than a UUID.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `task_${ts}_${rnd}`;
}

export function registerTask(
  entry: Omit<AsyncTaskEntry, 'state'> & {
    /** The brief, for the queue display. Optional for older callers. */
    text?: string;
  },
): AsyncTaskEntry {
  const sentinel = entry.parent_agent === 'sentinel';
  const depth = (entry.parent_depth ?? 0) + 1;
  const it = openWork({
    id: entry.task_id,
    origin: sentinel
      ? { kind: 'sentinel', triggerId: entry.parent_session, taskId: entry.task_id }
      : {
          kind: 'subagent',
          taskId: entry.task_id,
          depth,
          ...(entry.parent_session !== '?' ? { parent: { agent: entry.parent_agent, session: entry.parent_session } } : {}),
        },
    target: { agent: entry.target_agent, session: entry.target_session },
    requester: { agent: entry.parent_agent, session: entry.parent_session },
    text: entry.text ?? '',
    // The parent does not wait inline on an async sub; when it blocks in
    // subagent_result it fetches, which suppresses the wake.
    waiting: false,
    wake: sentinel || entry.attention === false ? 'never' : 'auto',
    ...(entry.parent_depth !== undefined ? { parentDepth: entry.parent_depth } : {}),
    // Opened as queued; toEntry shows it as 'running' to the tools, which
    // never had a queued state. The ledger itself needs the truth: a sub
    // still waiting for its session lock can be taken back, a running
    // one has to be stopped.
  });
  return toEntry(it);
}

export function completeTask(task_id: string, result: ChatTurnResult): void {
  finishWork(task_id, result);
}

export function failTask(task_id: string, error: string): void {
  failWork(task_id, error);
}

export function getTask(task_id: string): AsyncTaskEntry | undefined {
  const it = getWork(task_id);
  return it && TASK_KINDS.includes(it.origin.kind) ? toEntry(it) : undefined;
}

/** Tasks a parent started. Sentinel fires show only for the synthetic
 *  parent 'sentinel' itself (GET /spawn-list?parent_agent=sentinel). */
export function listTasksForAgent(parent_agent: string): AsyncTaskEntry[] {
  const kinds: Array<WorkItem['origin']['kind']> = parent_agent === 'sentinel' ? ['sentinel'] : ['subagent'];
  return listWork({ requester: { agent: parent_agent }, kinds }).map(toEntry);
}

/** Children of a given sub: tasks spawned FROM the sub's own session. */
export function listChildTasks(agent: string, session: string): AsyncTaskEntry[] {
  return listWork({ requester: { agent, session }, kinds: ['subagent'] }).map(toEntry);
}

/** Mark that the parent received the terminal state via
 *  subagent_result — suppresses the pending attention wake. */
export function markResultFetched(task_id: string): void {
  markFetched(task_id);
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
 * its own subs). The ledger marks first, then aborts the target
 * session's turn — the same signal the Stop button uses. Sync
 * (wait:true) grand-children are not registry-visible and are NOT
 * reached until Phase 3.
 */
export function cancelTaskCascade(task_id: string, reason: string): CancelOutcome | null {
  const out = cancelWork(task_id, reason);
  if (!out) return null;
  return {
    cancelled: out.cancelled,
    skipped: out.skipped.map((s) => ({
      task_id: s.id,
      state: s.state === 'done' ? 'done' : s.state === 'failed' ? 'failed' : 'cancelled',
    })),
  };
}

/** Resolve when the task leaves the 'running' state or `timeoutMs`
 *  passes (200 ms polling inside the server). */
export async function waitForTaskCompletion(task_id: string, timeoutMs: number): Promise<AsyncTaskEntry | null> {
  const it = await waitForWork(task_id, timeoutMs);
  return it && TASK_KINDS.includes(it.origin.kind) ? toEntry(it) : null;
}

// ── attention wake ────────────────────────────────────────────────────

interface AttentionDeps {
  dispatchWakeTurn: (args: { agent: string; session: string; text: string; taskId: string; depth: number }) => Promise<void>;
  /** Grace period before the wake check. */
  graceMs: number;
}

/** Compatibility wiring: routes every ledger wake through a task-shaped
 *  dispatcher. The server wires configureWorkWake directly; this is
 *  for callers (tests) that only know the task side. */
export function configureSubagentAttention(deps: AttentionDeps): void {
  configureWorkWake({
    graceMs: deps.graceMs,
    // The legacy shape carried the frame inside the text.
    dispatchWakeTurn: (w) => deps.dispatchWakeTurn({ agent: w.agent, session: w.session, text: w.prefix ? `${w.text}\n${w.prefix}` : w.text, taskId: w.ref, depth: w.depth }),
  });
}
