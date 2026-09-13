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
// Since 2026-09-13 (private/turn-dispatch-followup-design.md) the book
// also remembers during WHICH item a piece of work was started, so an
// answer that arrives after the turn that promised it has ended still
// reaches the one who asked: the follow-up (see maybeFollowUp below).
//
// In memory only, like the registries it replaces. Finished items are
// pruned after 24 h; the book holds at most 1000 entries and drops the
// oldest finished ones first. Running and waiting items are never
// dropped.

import type { TurnOrigin } from '../types/turn-origin.ts';
import { triggerChatAbort } from './chat-aborts.ts';
import { logger } from './logger.ts';
import type { ChatTurnResult } from './run-turn-types.ts';
import { dequeueSessionWork, getSessionLockStatus } from './session-queue.ts';

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
  /** The item whose turn was running in the requester's session when
   *  this one was opened — the work this one belongs to. A sub lisa
   *  spawns while answering naxon's call is `startedDuring` that call;
   *  a sub she spawns in the wake turn about that sub is `startedDuring`
   *  the wake item (chainRootOf follows it back to the call). */
  startedDuring?: string;
  /** When the requester last read the result (markFetched). A follow-up
   *  scheduled before that read is dropped. */
  lastFetchedAt?: number;
  /** Follow-ups sent for this item so far (ids of the turns that carried them). */
  followUpsSent?: number;
  /** Who cancelled it: a person (the queue popover, /queue in the TUI)
   *  wakes the requester like a take-back does — it did not do it
   *  itself; the requesting agent (subagent_cancel) knows; a child
   *  taken down with its parent (`cascade`) has no one left to tell. */
  cancelledBy?: 'human' | 'agent' | 'cascade';
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
  /** Explicit `startedDuring`; by default the active item of the
   *  requester's session (tests pass it, the server lets it default). */
  startedDuring?: string;
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
  const during = input.startedDuring ?? activeItemOf(input.requester);
  if (during && during !== it.id) it.startedDuring = during;
  // attention:false says "do not wake ME". When the sub was started
  // while answering someone else — a call, another agent — that someone
  // is told through the follow-up, and the follow-up needs the wake
  // turn. hans opted out twice on 2026-09-13 and the caller never heard
  // the result; the flag does not count then.
  if (it.wake === 'never' && it.origin.kind === 'subagent') {
    const root = chainRootOf(it);
    if (root && root.requester && !('human' in root.requester)) {
      it.wake = 'auto';
      logger.info({ msg: 'work.attention_overridden', id: it.id, root: root.id, root_kind: root.origin.kind, reason: 'someone is waiting for the outcome' });
    }
  }
  items.set(it.id, it);
  return it;
}

/** The item running in the requester's session right now — the one
 *  whose turn is calling the tool that opens this item. */
function activeItemOf(requester: WorkRequester | undefined): string | undefined {
  if (!requester || !('agent' in requester) || !requester.session || requester.session === '?') return undefined;
  const st = getSessionLockStatus(requester.agent, requester.session);
  return st.activeWorkId;
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
  if (it.origin.kind === 'wake') maybeFollowUp(it);
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
  if (it.origin.kind === 'wake') maybeFollowUp(it);
  return it;
}

export const WAKE_WITHDRAWN = 'withdrawn: the requester read the result before the wake turn started';

export function markFetched(id: string): void {
  const it = items.get(id);
  if (!it) return;
  it.resultFetched = true;
  it.lastFetchedAt = Date.now();
  const t = pendingWakes.get(id);
  if (t) {
    clearTimeout(t);
    pendingWakes.delete(id);
  }
  withdrawQueuedWake(id);
}

/**
 * The grace lost its race: the wake was dispatched 0.6 s before the
 * requester fetched the result, waited behind its running turn, and
 * then told it what it already knew — twice in Rene's hand test
 * (naxon's [agent answer], lisa's second [subagent attention],
 * 2026-09-13). A wake that has not started yet is taken out of the
 * queue when the result is read; one already running is left alone.
 */
function withdrawQueuedWake(ref: string): void {
  const w = items.get(`wake-${ref}`);
  if (!w || w.state !== 'queued') return;
  const outcome = dequeueSessionWork(w.target.agent, w.target.session, w.id);
  if (outcome.status !== 'removed') return;
  w.state = 'dequeued';
  w.error = WAKE_WITHDRAWN;
  w.finishedAt = Date.now();
  delete w.text;
  logger.info({ msg: 'work.wake_withdrawn', wake: w.id, ref, target_agent: w.target.agent, target_session: w.target.session });
  for (const l of finishListeners) l(w);
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
export function cancelWork(id: string, reason: string, by: 'human' | 'agent' = 'agent'): CancelOutcome | null {
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
    it.cancelledBy = it.id === root.id ? by : 'cascade';
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
      by: it.cancelledBy,
    });
    outcome.cancelled.push(it.id);
    // Stopped by a person from the requester's own queue popover (Rene,
    // 2026-09-13, hand test 10: lisa never learnt her sub was stopped):
    // the requester hears it like a take-back. Its own cancel, or a
    // child taken down with its parent, wakes no one.
    if (it.cancelledBy === 'human') scheduleWake(it);
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
  /** Item id for the wake turn; default `wake-<ref>`. A follow-up wake
   *  about the same ref needs its own. */
  id?: string;
}

/** A follow-up for an agent that asked: a message from the target back
 *  to the requester, framed as the late result of that call. */
export interface FollowUpMessage {
  from: { agent: string; session: string };
  to: { agent: string; session: string };
  callId: string;
  text: string;
  prefix: string;
  /** Item id for the message turn. */
  id: string;
}

export interface WorkWakeDeps {
  /** Grace before the wake — a requester that fetches right away needs none. */
  graceMs: number;
  dispatchWakeTurn: (args: WakeDispatch) => Promise<void>;
  /** Main server only: how a follow-up reaches an agent that asked
   *  (private/turn-dispatch-followup-design.md §2). Absent → no A2A
   *  follow-ups (tests, MCP child). */
  dispatchFollowUpMessage?: (args: FollowUpMessage) => Promise<void>;
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
 * Rene's hand test, 2026-09-13: the follow-up reached naxon on time and
 * carried lisa's wake-turn answer — "leaving it, as ordered". Lisa did
 * not know her answer was going anywhere. The wake turn's frame now
 * says where it goes, so the model writes it for the receiver.
 */
export function forwardingNoteFor(it: WorkItem): string | undefined {
  const root = chainRootOf(it);
  // A quick sub finishes while the root is still answering: the wake is
  // dispatched then and waits behind the root, so the note has to be
  // written while the root still runs (scratch N1, 2026-09-13). Only a
  // root that already ended without `done` gets none — no follow-up
  // will come.
  if (!root || (root.state !== 'done' && root.state !== 'running' && root.state !== 'queued')) return undefined;
  const r = root.requester;
  if (!r || 'human' in r) return undefined;
  const when = 'once all the work you started for it has finished';
  if ('voiceCall' in r) {
    return `What you answer in this turn is read out to the caller as the follow-up to their earlier question ${when} — write it as that answer, with the results.`;
  }
  if (root.origin.kind === 'agent') {
    return (
      `What you answer in this turn is forwarded to agent ${r.agent} as the follow-up to the question they sent ` +
      `(call_id "${root.id}") ${when} — write it as the answer to that question, with the results, not as a note to yourself.`
    );
  }
  return (
    `What you answer in this turn is forwarded to your parent (${r.agent}, session ${r.session}) as the follow-up to ` +
    `task '${root.id}' ${when} — write it as the report, with the results.`
  );
}

/**
 * The wake per finished kind: the record line (what happened) and the
 * frame beside it (what to do). Beside it, when the wake belongs to
 * work someone else asked for, where the answer of this turn goes
 * (forwardingNoteFor). The wording is the one each wake had
 * before the ledger (ask-calls.ts, async-tasks.ts, 2026-09-12/07),
 * split in two since 2026-09-13 (turn-framing.ts).
 */
export function wakeTextFor(it: WorkItem): { text: string; prefix: string } {
  const base = wakeTextBase(it);
  const note = forwardingNoteFor(it);
  return note ? { text: base.text, prefix: base.prefix ? `${base.prefix}\n\n${note}` : note } : base;
}

function wakeTextBase(it: WorkItem): { text: string; prefix: string } {
  if (it.wakeText) return { text: it.wakeText, prefix: it.wakePrefix ?? '' };
  if (it.state === 'cancelled') {
    return it.origin.kind === 'agent'
      ? {
          text:
            `[agent answer] The question you sent to ${it.target.agent} (session '${it.target.session}') was stopped ` +
            `by the user before it was answered (call_id "${it.id}").`,
          prefix: 'Ask again only if the user still wants it; otherwise tell your human in one line.',
        }
      : {
          text:
            `[subagent attention] Task '${it.id}' (sub-agent '${it.target.agent}', session '${it.target.session}') was ` +
            `stopped by the user before it finished — there is no result${it.error ? ` (${it.error})` : ''}.`,
          prefix: 'Spawn it again only if the user still wants it; otherwise tell your human in one line.',
        };
  }
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

type FollowUpListener = (root: WorkItem, followUp: { text: string; failed?: string }) => void;
const followUpListeners: FollowUpListener[] = [];

/** Hear every follow-up whose root was asked by a voice call: the
 *  realtime manager reads it out. Agent and sub-agent follow-ups go
 *  through the wake deps instead. */
export function onWorkFollowUp(listener: FollowUpListener): () => void {
  followUpListeners.push(listener);
  return () => {
    const i = followUpListeners.indexOf(listener);
    if (i >= 0) followUpListeners.splice(i, 1);
  };
}

/**
 * The item a piece of work ultimately belongs to: follow `startedDuring`
 * back, treating a wake turn about Z as part of Z's chain. Undefined
 * for an item nobody started from inside another item's turn.
 */
export function chainRootOf(it: WorkItem): WorkItem | undefined {
  const seen = new Set<string>();
  let cur: WorkItem | undefined = it;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.origin.kind === 'wake') {
      cur = items.get(cur.origin.ref);
      continue;
    }
    if (!cur.startedDuring) return undefined;
    const parent = items.get(cur.startedDuring);
    if (!parent) return undefined;
    if (parent.origin.kind === 'wake') {
      cur = parent;
      continue;
    }
    return parent;
  }
  return undefined;
}

/** Is `it` anywhere below `rootId` — a child, a grandchild through a
 *  sub's own chain, a wake turn about any of them? */
export function inTreeOf(it: WorkItem, rootId: string): boolean {
  const seen = new Set<string>();
  let cur = chainRootOf(it);
  while (cur && !seen.has(cur.id)) {
    if (cur.id === rootId) return true;
    seen.add(cur.id);
    cur = chainRootOf(cur);
  }
  return false;
}

/** Everything still open below a root: queued or running items at any
 *  depth (a grandchild counts — naxon should hear once, after the whole
 *  tree, not once per level), and finished ones whose wake is still in
 *  its grace. */
export function openChainMembers(rootId: string): WorkItem[] {
  const out: WorkItem[] = [];
  for (const c of items.values()) {
    if (c.id === rootId) continue;
    const open = c.state === 'queued' || c.state === 'running' || pendingWakes.has(c.id);
    if (!open) continue;
    if (inTreeOf(c, rootId)) out.push(c);
  }
  return out;
}

/** The final texts of the target's own wake turns for a root's work,
 *  oldest first, empty and repeated ones dropped. */
export function wakeAnswersFor(root: WorkItem): string[] {
  const since = root.finishedAt ?? 0;
  const turns = [...items.values()]
    .filter(
      (w) =>
        w.origin.kind === 'wake' &&
        w.state === 'done' &&
        (w.finishedAt ?? 0) >= since &&
        w.target.agent === root.target.agent &&
        w.target.session === root.target.session &&
        inTreeOf(w, root.id),
    )
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const out: string[] = [];
  for (const w of turns) {
    const t = (w.result?.finalText ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export const FOLLOW_UP_PREFIX_A2A = (callId: string): string =>
  `[Follow-up on the question you sent earlier (call_id "${callId}"): the work it started has finished. ` +
  'Below is its result — treat it as the answer to that question. Continue whatever depended on it; ' +
  'if nothing does, tell your human in one line.]';

/**
 * A wake turn about a chain member ended (design §1). When the chain's
 * root is a finished item someone asked for and nothing in the chain is
 * still open, the requester hears about it exactly once: an agent as a
 * message from the target (dispatchFollowUpMessage), a parent as one
 * more [subagent attention] wake, a voice call through its listener.
 */
function maybeFollowUp(wake: WorkItem): void {
  if (wake.origin.kind !== 'wake') return;
  const deps = wakeDeps;
  const child = items.get(wake.origin.ref);
  const root = child ? chainRootOf(child) : undefined;
  const skip = (reason: string): void => {
    logger.info({ msg: 'work.follow_up_skipped', wake: wake.id, root: root?.id ?? null, reason });
  };
  if (!deps) return;
  if (!child || !root) return; // nothing above this wake — the normal case for a person's session
  if (root.state !== 'done') return skip('root_not_done');
  const r = root.requester;
  if (!r || 'human' in r) return skip('no_requester');
  if (wake.state === 'failed' && wake.error === 'stopped by the user') return skip('stopped_by_user');
  const open = openChainMembers(root.id);
  if (open.length > 0) return skip(`open_children:${open.length}`);
  // The model reported on its own: an A2A message from the target's
  // session to the requester, opened after the root finished.
  if ('agent' in r) {
    const self = [...items.values()].some(
      (c) =>
        c.origin.kind === 'agent' &&
        c.requester !== undefined &&
        'agent' in c.requester &&
        c.requester.agent === root.target.agent &&
        c.requester.session === root.target.session &&
        c.target.agent === r.agent &&
        c.target.session === r.session &&
        c.enqueuedAt >= (root.finishedAt ?? 0),
    );
    if (self) return skip('self_reported');
  }
  // What the target wrote about this work: the answers of ALL its wake
  // turns in the tree since the root finished, in order — not only the
  // last one. In Rene's hand test the three points stood in the first
  // wake turn and the last one said "duplicate"; the asker got the
  // duplicate.
  const body = wakeAnswersFor(root).join('\n\n');
  const failed = wake.state === 'failed' ? (wake.error ?? 'unknown error') : undefined;
  if (!body && !failed) return skip('empty');
  const scheduledAt = Date.now();
  const n = (root.followUpsSent ?? 0) + 1;
  root.followUpsSent = n;
  const timer = setTimeout(() => {
    const fresh = items.get(root.id);
    if (!fresh) return;
    if ((fresh.lastFetchedAt ?? 0) >= scheduledAt) return skip('fetched_meanwhile');
    logger.info({ msg: 'work.follow_up', root: root.id, wake: wake.id, kind: root.origin.kind, n, ...(failed ? { failed } : {}) });
    const text = failed
      ? body
        ? `${body}\n\n(The last turn reporting on this work failed: ${failed})`
        : `The work started for this finished, but the turn reporting it failed: ${failed}`
      : body;
    if (fresh.result) fresh.result = { ...fresh.result, follow_ups: [...(fresh.result.follow_ups ?? []), text] };
    if ('voiceCall' in r) {
      for (const l of followUpListeners) l(fresh, { text, ...(failed ? { failed } : {}) });
      return;
    }
    if (root.origin.kind === 'agent') {
      if (!deps.dispatchFollowUpMessage) return skip('no_message_dispatcher');
      void deps
        .dispatchFollowUpMessage({
          from: root.target,
          to: { agent: r.agent, session: r.session },
          callId: root.id,
          text,
          prefix: FOLLOW_UP_PREFIX_A2A(root.id),
          id: `followup-${root.id}-${n}`,
        })
        .catch((err: unknown) => logger.warn({ msg: 'work.follow_up_failed', root: root.id, err: (err as Error).message }));
      return;
    }
    const about = aboutOf(root.origin);
    if (!about) return skip('no_wake_kind');
    const head = text.replace(/\s+/g, ' ').slice(0, 160);
    void deps
      .dispatchWakeTurn({
        agent: r.agent,
        session: r.session,
        text:
          `[subagent attention] Task '${root.id}' (sub-agent '${root.target.agent}', session '${root.target.session}') ` +
          `has a follow-up: the work it started has finished. It begins: "${head}"`,
        prefix:
          `Fetch it with subagent_result({ task_id: "${root.id}" }) — the follow-up is in its follow_ups field — ` +
          'then continue whatever depended on it. If nothing does, a short acknowledgement to the user is enough.' +
          (forwardingNoteFor(fresh) ? `\n\n${forwardingNoteFor(fresh)}` : ''),
        about,
        ref: root.id,
        depth: fresh.parentDepth ?? 0,
        id: `wake-${root.id}-fu${n}`,
      })
      .catch((err: unknown) => logger.warn({ msg: 'work.follow_up_failed', root: root.id, err: (err as Error).message }));
  }, deps.graceMs);
  timer.unref?.();
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
  if (it.state !== 'done' && it.state !== 'failed' && it.state !== 'dequeued' && !(it.state === 'cancelled' && it.cancelledBy === 'human')) return;
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
  followUpListeners.length = 0;
  items.clear();
  for (const t of pendingWakes.values()) clearTimeout(t);
  pendingWakes.clear();
}
