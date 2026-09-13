// The work ledger — one book for everything an agent has been asked to
// do that is not the person typing right now.
//
// Until 2026-09-13 four places knew a part of that: the ask-call
// registry (agent_ask), the async-task registry (sub-agents, and
// sentinel fires dressed up as sub-agents), the video job files, and
// nothing at all for a voice consult. Each had its own states, its own
// wake timer with its own grace and its own suppression rule, and none
// of them carried the text — so "what is this agent still going to do"
// could be counted but never shown (private/turn-triggers-birdseye.md
// §5, private/turn-dispatch-phase2-design.md).
//
// This module is the single answer. ask-calls.ts and async-tasks.ts
// keep their exported functions and shapes as VIEWS over it, so every
// tool, route and test that reads them keeps working unchanged.
//
// In memory only, like the registries it replaces. Finished items are
// pruned after 24 h; the book holds at most 1000 entries and drops the
// oldest finished ones first. Running and waiting items are never
// dropped.

import type { TurnOrigin } from '../types/turn-origin.ts';
import { triggerChatAbort } from './chat-aborts.ts';
import { logger } from './logger.ts';
import type { ChatTurnResult } from './run-turn-types.ts';
import { dequeueSessionWork } from './session-queue.ts';

export type WorkState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'dequeued';

export type WorkRequester =
  /** Another agent's session started this (agent_ask, spawn). */
  | { agent: string; session: string }
  /** A person, through a client. */
  | { human: true }
  /** The voice self of a realtime call (consult). */
  | { voiceCall: string };

export interface WorkItem {
  /** agent_ask: call_id · sub/sentinel: task_id · human: turnId · voice: consultId · video: job id */
  id: string;
  origin: TurnOrigin;
  target: { agent: string; session: string };
  requester?: WorkRequester;
  state: WorkState;
  /** First 160 characters of the text, newlines collapsed — the only
   *  trace of the prompt this book keeps. */
  preview: string;
  /** Full text and attachments, kept ONLY while the item waits, so a
   *  taken-back human turn can hand them back (DELETE /chat/queue). */
  text?: string;
  attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  turnId?: string;
  result?: ChatTurnResult;
  error?: string;
  /** The requester is still on the line (inline wait). A wake is only
   *  for a requester that has hung up. */
  waiting: boolean;
  /** The requester read the result — no wake needed. */
  resultFetched: boolean;
  wake: 'auto' | 'never';
  /** Nesting depth of the requester (a sub-orchestrator keeps it across
   *  the wake). */
  parentDepth?: number;
  /** Text a finisher hands over for the wake, when the default per-kind
   *  template does not know the item's domain (video). */
  wakeText?: string;
  /** Its frame — what to do about it — beside the text (turn-framing.ts). */
  wakePrefix?: string;
  /** Media to attach to the wake turn (a finished video). */
  wakeMediaIds?: string[];
}

export type WorkItemView = Omit<WorkItem, 'text' | 'attachments' | 'result'>;

const MAX_ITEMS = 1000;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const items = new Map<string, WorkItem>();

export const REMOVED_BY_USER = 'removed from the queue by the user before it started';

export function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function prune(): void {
  const now = Date.now();
  for (const [id, it] of items) {
    if (it.finishedAt !== undefined && now - it.finishedAt > TERMINAL_TTL_MS) items.delete(id);
  }
  if (items.size <= MAX_ITEMS) return;
  const finished = [...items.values()]
    .filter((it) => it.finishedAt !== undefined)
    .sort((a, b) => a.finishedAt! - b.finishedAt!);
  for (const it of finished) {
    if (items.size <= MAX_ITEMS) break;
    items.delete(it.id);
  }
}

export interface OpenWorkInput {
  id: string;
  origin: TurnOrigin;
  target: { agent: string; session: string };
  requester?: WorkRequester;
  text: string;
  attachments?: WorkItem['attachments'];
  /** Default true: the requester waits inline for the result. */
  waiting?: boolean;
  /** Default 'auto' — a finished item wakes its requester. */
  wake?: 'auto' | 'never';
  parentDepth?: number;
  /** Already running (no queue wait ahead) — sentinel and spawn used to
   *  register their tasks as running from the start. */
  running?: boolean;
}

export function openWork(input: OpenWorkInput): WorkItem {
  prune();
  const it: WorkItem = {
    id: input.id,
    origin: input.origin,
    target: input.target,
    ...(input.requester ? { requester: input.requester } : {}),
    state: input.running ? 'running' : 'queued',
    preview: previewOf(input.text),
    text: input.text,
    ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    enqueuedAt: Date.now(),
    ...(input.running ? { startedAt: Date.now() } : {}),
    waiting: input.waiting ?? true,
    resultFetched: false,
    wake: input.wake ?? 'auto',
    ...(input.parentDepth !== undefined ? { parentDepth: input.parentDepth } : {}),
  };
  items.set(it.id, it);
  return it;
}

/** The lock was granted; the turn runs. The waiting-only text is dropped. */
export function markRunning(id: string, turnId?: string): void {
  const it = items.get(id);
  if (!it || it.state !== 'queued') return;
  it.state = 'running';
  it.startedAt = Date.now();
  if (turnId) it.turnId = turnId;
  delete it.text;
  delete it.attachments;
}

export interface FinishOptions {
  wakeText?: string;
  wakePrefix?: string;
  wakeMediaIds?: string[];
}

/** The turn ended. Terminal states are final: a cancelled or dequeued
 *  item whose promise settles later keeps its state. */
export function finishWork(id: string, result: ChatTurnResult, opts: FinishOptions = {}): WorkItem | undefined {
  const it = items.get(id);
  if (!it) return undefined;
  if (it.state !== 'queued' && it.state !== 'running') return it;
  it.state = result.error ? 'failed' : 'done';
  it.result = result;
  if (result.error) it.error = result.error;
  it.finishedAt = Date.now();
  if (opts.wakeText) it.wakeText = opts.wakeText;
  if (opts.wakePrefix) it.wakePrefix = opts.wakePrefix;
  if (opts.wakeMediaIds && opts.wakeMediaIds.length > 0) it.wakeMediaIds = opts.wakeMediaIds;
  delete it.text;
  delete it.attachments;
  settle(it);
  return it;
}

export function failWork(id: string, error: string, opts: FinishOptions = {}): WorkItem | undefined {
  const it = items.get(id);
  if (!it) return undefined;
  if (it.state !== 'queued' && it.state !== 'running') return it;
  it.state = 'failed';
  it.error = error;
  it.finishedAt = Date.now();
  if (opts.wakeText) it.wakeText = opts.wakeText;
  if (opts.wakePrefix) it.wakePrefix = opts.wakePrefix;
  delete it.text;
  delete it.attachments;
  settle(it);
  return it;
}

export function markFetched(id: string): void {
  const it = items.get(id);
  if (!it) return;
  it.resultFetched = true;
  const t = pendingWakes.get(id);
  if (t) {
    clearTimeout(t);
    pendingWakes.delete(id);
  }
}

export function setWaiting(id: string, waiting: boolean): void {
  const it = items.get(id);
  if (it) it.waiting = waiting;
}

export function getWork(id: string): WorkItem | undefined {
  return items.get(id);
}

export interface WorkFilter {
  target?: { agent: string; session?: string };
  requester?: { agent: string; session?: string };
  states?: WorkState[];
  kinds?: Array<TurnOrigin['kind']>;
}

export function listWork(filter: WorkFilter = {}): WorkItem[] {
  const out: WorkItem[] = [];
  for (const it of items.values()) {
    if (filter.target) {
      if (it.target.agent !== filter.target.agent) continue;
      if (filter.target.session !== undefined && it.target.session !== filter.target.session) continue;
    }
    if (filter.requester) {
      const r = it.requester;
      if (!r || !('agent' in r) || r.agent !== filter.requester.agent) continue;
      if (filter.requester.session !== undefined && r.session !== filter.requester.session) continue;
    }
    if (filter.states && !filter.states.includes(it.state)) continue;
    if (filter.kinds && !filter.kinds.includes(it.origin.kind)) continue;
    out.push(it);
  }
  return out.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** Poll until the item leaves queued/running or `timeoutMs` passes
 *  (200 ms cadence — the caller blocks server-side instead of burning
 *  agent-loop rounds). */
export async function waitForWork(id: string, timeoutMs: number): Promise<WorkItem | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const it = items.get(id);
    if (!it) return null;
    if (it.state !== 'queued' && it.state !== 'running') return it;
    await new Promise((r) => setTimeout(r, 200));
  }
  return items.get(id) ?? null;
}

// ── cancel (running) ──────────────────────────────────────────────────

export interface CancelOutcome {
  cancelled: string[];
  skipped: Array<{ id: string; state: WorkState }>;
}

/** Items started FROM an item's target session — the sub-agents (and
 *  asks) a sub-orchestrator itself started. */
export function childrenOf(target: { agent: string; session: string }): WorkItem[] {
  return listWork({ requester: target });
}

/**
 * Cancel a running item AND its descendants. Marks the registry state
 * FIRST (so the settling promise cannot overwrite it), then triggers the
 * chat-abort signal for the target session — the same signal the Stop
 * button uses. Breadth-first over the requester tree. Disk artifacts
 * stay untouched.
 */
export function cancelWork(id: string, reason: string): CancelOutcome | null {
  const root = items.get(id);
  if (!root) return null;
  const outcome: CancelOutcome = { cancelled: [], skipped: [] };
  const queue: WorkItem[] = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const it = queue.shift()!;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    queue.push(...childrenOf(it.target));
    if (it.state !== 'running' && it.state !== 'queued') {
      outcome.skipped.push({ id: it.id, state: it.state });
      continue;
    }
    it.state = 'cancelled';
    it.error = reason;
    it.finishedAt = Date.now();
    delete it.text;
    delete it.attachments;
    // Ask the session queue, not the item: an item still waiting for the
    // lock is spliced out and the session's abort signal is NOT touched
    // — the turn running there belongs to someone else (scratch smoke
    // 2026-09-13: cancelling a waiting sub stopped the occupant's turn).
    // An item the queue does not hold (running, or never queued through
    // the lock at all) gets the abort.
    const dq = dequeueSessionWork(it.target.agent, it.target.session, it.id);
    const wasQueued = dq.status === 'removed';
    const abortDelivered = wasQueued ? false : triggerChatAbort(it.target.agent, it.target.session).aborted;
    for (const l of finishListeners) l(it);
    logger.info({
      msg: 'work.cancelled',
      id: it.id,
      kind: it.origin.kind,
      target_agent: it.target.agent,
      target_session: it.target.session,
      abort_delivered: abortDelivered,
      was_queued: wasQueued,
      reason,
    });
    outcome.cancelled.push(it.id);
  }
  return outcome;
}

// ── dequeue (waiting) ─────────────────────────────────────────────────

export type DequeueBy = 'human' | { agent: string };

export type DequeueWorkOutcome =
  | { status: 'removed'; item: WorkItem }
  | { status: 'running'; item: WorkItem }
  | { status: 'forbidden'; item: WorkItem }
  | { status: 'unknown' };

/**
 * Take a waiting item back before it starts. A person may remove any
 * item; an agent only what it asked for itself (Rene, 2026-09-13). The
 * waiter's acquire() rejects with DequeuedError, so the caller that
 * queued it never runs the turn; the item reads `dequeued` with the
 * reason, and whoever asks for the result reads failed + reason.
 */
export function dequeueWork(id: string, by: DequeueBy): DequeueWorkOutcome {
  const it = items.get(id);
  if (!it) return { status: 'unknown' };
  if (it.state === 'running') return { status: 'running', item: it };
  if (it.state !== 'queued') return { status: 'unknown' };
  if (by !== 'human') {
    const r = it.requester;
    if (!r || !('agent' in r) || r.agent !== by.agent) return { status: 'forbidden', item: it };
  }
  const outcome = dequeueSessionWork(it.target.agent, it.target.session, it.id);
  if (outcome.status === 'running') return { status: 'running', item: it };
  it.state = 'dequeued';
  it.error = REMOVED_BY_USER;
  it.finishedAt = Date.now();
  logger.info({
    msg: 'work.dequeued',
    id: it.id,
    kind: it.origin.kind,
    target_agent: it.target.agent,
    target_session: it.target.session,
    by: by === 'human' ? 'human' : by.agent,
    waitedMs: Date.now() - it.enqueuedAt,
  });
  // The text stays on the item until the caller has read it back
  // (DELETE /chat/queue returns it), then the item is a record only.
  for (const l of finishListeners) l(it);
  // A requester that hung up learns about it the same way it would
  // have learnt about the answer (Rene, 2026-09-13: naxon only found
  // out that lisa's queue had been cleared when he went looking).
  scheduleWake(it);
  return { status: 'removed', item: it };
}

// ── wake ─────────────────────────────────────────────────────────────

export interface WakeDispatch {
  agent: string;
  session: string;
  /** The record line: what happened. */
  text: string;
  /** What to do about it — beside the text (turn-framing.ts). */
  prefix: string;
  about: 'a2a' | 'subagent' | 'job';
  ref: string;
  depth: number;
  mediaIds?: string[];
}

export interface WorkWakeDeps {
  /** Grace before the wake — a requester that fetches right away needs none. */
  graceMs: number;
  dispatchWakeTurn: (args: WakeDispatch) => Promise<void>;
}

let wakeDeps: WorkWakeDeps | null = null;
const pendingWakes = new Map<string, ReturnType<typeof setTimeout>>();

export function configureWorkWake(deps: WorkWakeDeps): void {
  wakeDeps = deps;
}

/** Items whose wake timer is still pending, for a requester session. */
export function pendingWakesFor(requester: { agent: string; session: string }): WorkItem[] {
  const out: WorkItem[] = [];
  for (const id of pendingWakes.keys()) {
    const it = items.get(id);
    if (!it || !it.requester || !('agent' in it.requester)) continue;
    if (it.requester.agent === requester.agent && it.requester.session === requester.session) out.push(it);
  }
  return out;
}

type FinishListener = (item: WorkItem) => void;
const finishListeners: FinishListener[] = [];

/** Hear every terminal transition: done, failed, dequeued, cancelled.
 *  The realtime voice manager listens for its consults; the server
 *  publishes queue changes to the clients. */
export function onWorkFinished(listener: FinishListener): () => void {
  finishListeners.push(listener);
  return () => {
    const i = finishListeners.indexOf(listener);
    if (i >= 0) finishListeners.splice(i, 1);
  };
}

function settle(it: WorkItem): void {
  for (const l of finishListeners) l(it);
  scheduleWake(it);
}

export function aboutOf(origin: TurnOrigin): WakeDispatch['about'] | null {
  switch (origin.kind) {
    case 'agent':
      return 'a2a';
    case 'subagent':
      return 'subagent';
    case 'wake':
      return origin.about === 'job' ? 'job' : null;
    default:
      return null;
  }
}

function head(it: WorkItem, n: number): string {
  return (it.result?.finalText ?? it.error ?? '').replace(/\s+/g, ' ').slice(0, n);
}

/**
 * The wake per finished kind: the record line (what happened) and the
 * frame beside it (what to do). The wording is the one each wake had
 * before the ledger (ask-calls.ts, async-tasks.ts, 2026-09-12/07),
 * split in two since 2026-09-13 (turn-framing.ts).
 */
export function wakeTextFor(it: WorkItem): { text: string; prefix: string } {
  if (it.wakeText) return { text: it.wakeText, prefix: it.wakePrefix ?? '' };
  if (it.state === 'dequeued') {
    return it.origin.kind === 'agent'
      ? {
          text:
            `[agent answer] The question you sent to ${it.target.agent} (session '${it.target.session}') was removed ` +
            `from the queue by the user before ${it.target.agent} saw it — it will not be answered (call_id "${it.id}").`,
          prefix: 'Ask again only if the user still wants it; otherwise tell your human in one line.',
        }
      : {
          text:
            `[subagent attention] Task '${it.id}' (sub-agent '${it.target.agent}', session '${it.target.session}') was ` +
            `removed from the queue by the user before it started — there is no result.`,
          prefix: 'Spawn it again only if the user still wants it; otherwise tell your human in one line.',
        };
  }
  if (it.origin.kind === 'agent') {
    const h = head(it, 200);
    return {
      text:
        `[agent answer] ${it.target.agent} has answered the question you sent to session ` +
        `'${it.target.session}' — you had stopped waiting for it.` +
        (h ? ` It begins: "${h}"` : ''),
      prefix:
        `Read the whole answer with agent_ask_result({ call_id: "${it.id}" }), then do what ` +
        'depended on it. If nothing does, tell your human in one line what came back.',
    };
  }
  const h = head(it, 160);
  const media = it.result?.media ?? [];
  const mediaLine = media.length > 0 ? ` Generated media (${media.length}): ${media.map((m) => m.path).join(', ')}.` : '';
  const files = it.result?.files_written ?? [];
  const filesLine = files.length > 0 ? ` Files written (${files.length}): ${files.join(', ')}.` : '';
  const outcome = it.result?.outcome;
  const outcomeLine = outcome
    ? ` Outcome: ${outcome}${it.result?.outcome_reason ? ` (${it.result.outcome_reason})` : ''}, ` +
      `${it.result?.tool_calls ?? 0} tool calls` +
      (it.result?.rounds !== undefined ? `, ${it.result.rounds} rounds` : '') +
      '.'
    : '';
  return {
    text:
      `[subagent attention] Task '${it.id}' (sub-agent '${it.target.agent}', session ` +
      `'${it.target.session}') finished with state '${it.state}'.` +
      outcomeLine +
      (h ? ` First line: "${h}"` : '') +
      filesLine +
      mediaLine,
    prefix:
      `Fetch the full answer with subagent_result({ task_id: "${it.id}" }), then continue ` +
      'whatever depended on it (validate, report to the user, or chain the next step). If nothing ' +
      'depends on it, a short acknowledgement to the user is enough.',
  };
}

/**
 * One wake for every kind (design §1.4). Fires after `graceMs` and only
 * when: deps are wired (main server only), wake is 'auto', the state is
 * done or failed (cancelled/dequeued: whoever did it knows), the
 * requester hung up (not waiting inline), the requester is an agent
 * session that exists, and nobody fetched the result meanwhile.
 */
function scheduleWake(it: WorkItem): void {
  const deps = wakeDeps;
  if (!deps) return;
  if (it.wake !== 'auto') return;
  if (it.state !== 'done' && it.state !== 'failed' && it.state !== 'dequeued') return;
  if (it.waiting) return;
  const r = it.requester;
  if (!r || !('agent' in r) || !r.session || r.session === '?') return;
  const about = aboutOf(it.origin);
  if (!about) return;
  const timer = setTimeout(() => {
    pendingWakes.delete(it.id);
    const fresh = items.get(it.id);
    if (!fresh || fresh.resultFetched) return;
    logger.info({ msg: 'work.wake', id: it.id, about, requester_agent: r.agent, requester_session: r.session, state: fresh.state });
    const wake = wakeTextFor(fresh);
    void deps
      .dispatchWakeTurn({
        agent: r.agent,
        session: r.session,
        text: wake.text,
        prefix: wake.prefix,
        about,
        ref: it.id,
        depth: fresh.parentDepth ?? 0,
        ...(fresh.wakeMediaIds ? { mediaIds: fresh.wakeMediaIds } : {}),
      })
      .catch((err: unknown) => {
        logger.warn({ msg: 'work.wake_failed', id: it.id, err: (err as Error).message });
      });
  }, deps.graceMs);
  timer.unref?.();
  pendingWakes.set(it.id, timer);
}

/** Test seam. */
export function _resetWorkLedger(): void {
  items.clear();
  for (const t of pendingWakes.values()) clearTimeout(t);
  pendingWakes.clear();
}
