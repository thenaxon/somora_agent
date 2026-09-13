// agent_ask call registry — since 2026-09-13 a VIEW over the work
// ledger (work-ledger.ts). The functions and shapes here are what
// agent_ask_result, GET /a2a/ask-result and the ask-attention test
// read; they stay byte-compatible while the state lives in one book
// with the sub-agent tasks and the voice consults.
//
// Lifecycle (unchanged): registerAskCall (queued) → markAskCallRunning
// → completeAskCall / failAskCall. An asker that hung up before the
// answer (markAskCallPending) is woken by the ledger's single wake.
// After a restart the registry is empty and GET /a2a/ask-result falls
// back to the target session's history (user_message.agent_ask_call_id).

import type { ChatTurnResult } from './run-turn-types.ts';
import {
  configureWorkWake,
  failWork,
  finishWork,
  getWork,
  markFetched,
  markRunning,
  openWork,
  setWaiting,
  waitForWork,
  type WorkItem,
} from './work-ledger.ts';

export type AskCallState = 'queued' | 'running' | 'done' | 'failed';

export interface AskCallEntry {
  call_id: string;
  state: AskCallState;
  from_agent: string;
  from_session?: string;
  target_agent: string;
  target_session: string;
  started_at: number;
  finished_at?: number;
  result?: ChatTurnResult;
  error?: string;
  /** The asker stopped waiting: `agent_ask` returned `pending`. Only
   *  such a call needs waking — a caller still holding the line gets
   *  the answer as its tool result. */
  went_pending?: boolean;
  /** The asker read the result (agent_ask_result). No wake needed. */
  result_fetched?: boolean;
}

function toEntry(it: WorkItem): AskCallEntry {
  const from = it.origin.kind === 'agent' ? it.origin.from : { agent: '?' as string, session: undefined as string | undefined };
  const state: AskCallState =
    it.state === 'queued' ? 'queued' : it.state === 'running' ? 'running' : it.state === 'done' ? 'done' : 'failed';
  return {
    call_id: it.id,
    state,
    from_agent: from.agent,
    ...(from.session ? { from_session: from.session } : {}),
    target_agent: it.target.agent,
    target_session: it.target.session,
    started_at: it.enqueuedAt,
    ...(it.finishedAt !== undefined ? { finished_at: it.finishedAt } : {}),
    ...(it.result ? { result: it.result } : {}),
    ...(it.error ? { error: it.error } : {}),
    ...(it.waiting ? {} : { went_pending: true }),
    ...(it.resultFetched ? { result_fetched: true } : {}),
  };
}

export interface AskAttentionDeps {
  dispatchWakeTurn(args: { agent: string; session: string; text: string; callId: string }): Promise<void>;
  /** Grace period: an asker that polls right away needs no wake. */
  graceMs: number;
}

/** Compatibility wiring: routes every ledger wake through an ask-shaped
 *  dispatcher. The server wires configureWorkWake directly; this is
 *  for callers (tests) that only know the ask side. */
export function configureAskAttention(deps: AskAttentionDeps): void {
  configureWorkWake({
    graceMs: deps.graceMs,
    // The legacy shape carried the frame inside the text.
    dispatchWakeTurn: (w) => deps.dispatchWakeTurn({ agent: w.agent, session: w.session, text: w.prefix ? `${w.text}\n${w.prefix}` : w.text, callId: w.ref }),
  });
}

export function markAskCallPending(call_id: string): void {
  setWaiting(call_id, false);
}

export function registerAskCall(
  entry: Omit<AskCallEntry, 'state' | 'started_at' | 'finished_at' | 'result' | 'error'> & {
    /** The question, for the queue display. Optional for older callers. */
    text?: string;
    /** `agent_ask wait:false`: the asker never waits inline. */
    detached?: boolean;
  },
): AskCallEntry {
  const it = openWork({
    id: entry.call_id,
    origin: {
      kind: 'agent',
      from: { agent: entry.from_agent, ...(entry.from_session ? { session: entry.from_session } : {}) },
      callId: entry.call_id,
    },
    target: { agent: entry.target_agent, session: entry.target_session },
    requester: { agent: entry.from_agent, session: entry.from_session ?? '?' },
    text: entry.text ?? '',
    waiting: !entry.detached,
  });
  return toEntry(it);
}

export function markAskCallRunning(call_id: string): void {
  markRunning(call_id);
}

export function completeAskCall(call_id: string, result: ChatTurnResult): void {
  finishWork(call_id, result);
}

export function failAskCall(call_id: string, error: string): void {
  failWork(call_id, error);
}

export function getAskCall(call_id: string): AskCallEntry | undefined {
  const it = getWork(call_id);
  if (!it || it.origin.kind !== 'agent') return undefined;
  // Reading a finished call IS fetching it: no wake afterwards, or the
  // asker is told twice about an answer it already has.
  if (it.finishedAt !== undefined) markFetched(call_id);
  return toEntry(it);
}

/** Poll until the call reaches a terminal state or `timeoutMs` passes. */
export async function waitForAskCall(call_id: string, timeoutMs: number): Promise<AskCallEntry | null> {
  const it = await waitForWork(call_id, timeoutMs);
  return it && it.origin.kind === 'agent' ? toEntry(it) : null;
}
