// A2A call registry — the server-side record of every agent_ask round
// trip, keyed by the call_id agent_ask minted. Companion to
// async-tasks.ts (spawn_subagent's task store): a caller whose
// agent_ask timed out gets `state: 'pending'` + call_id back, and
// until 2026-09-07 had NO way to learn how that call ended — the hint
// even suggested re-sending the message, which risks running the
// target's work twice (2026-09-06 a2a-pending-result-retrieval
// report). `agent_ask_result` (src/tools/agents/ask-result.ts) reads
// this registry through GET /a2a/ask-result.
//
// Lifecycle (driven by /chat/send-sync in index.ts):
//   queued  → registered before the target's session lock is requested
//   running → lock acquired, runChatTurn started
//   done    → turn returned (result.error empty)
//   failed  → turn returned with error, or threw
//
// In-memory, process-local like async-tasks. Entries outlive the
// call so late fetches work; pruning keeps the map bounded. After a
// server restart the route falls back to the target session's JSONL
// (user_message.agent_ask_call_id is persisted), see index.ts.

import type { ChatTurnResult } from './run-turn-types.ts';

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

/**
 * Wake the asker when a call it stopped waiting for finishes.
 *
 * A spawned sub-agent has done this since 2026-07-28; an agent_ask
 * never did, and the difference cost a real result: 2026-09-12,
 * hans asked lisa for research with the minimum timeout, got `pending`
 * after 1.005 s and ended his turn four seconds later. Lisa worked for
 * 208 seconds and wrote a full answer — into her own session. The
 * result sat in this registry, correct and complete, and nobody ever
 * learned it existed.
 */
export interface AskAttentionDeps {
  dispatchWakeTurn(args: { agent: string; session: string; text: string }): Promise<void>;
  /** Grace period: an asker that polls right away needs no wake. */
  graceMs: number;
}

let askAttentionDeps: AskAttentionDeps | null = null;

export function configureAskAttention(deps: AskAttentionDeps): void {
  askAttentionDeps = deps;
}

export function markAskCallPending(call_id: string): void {
  const e = calls.get(call_id);
  if (e) e.went_pending = true;
}

function askWakePrompt(e: AskCallEntry): string {
  const head = (e.result?.finalText ?? e.error ?? '').replace(/\s+/g, ' ').slice(0, 200);
  return (
    `[agent answer] ${e.target_agent} has answered the question you sent to session ` +
    `'${e.target_session}' — you had stopped waiting for it.` +
    (head ? ` It begins: "${head}"` : '') +
    `\nRead the whole answer with agent_ask_result({ call_id: "${e.call_id}" }), then do what ` +
    `depended on it. If nothing does, tell your human in one line what came back.`
  );
}

function scheduleAskWake(e: AskCallEntry): void {
  const deps = askAttentionDeps;
  if (!deps) return;
  // Still on the line? Then the answer is already on its way back as a
  // tool result, and a wake would be a duplicate.
  if (!e.went_pending) return;
  if (!e.from_session || e.from_session === '?') return;
  const timer = setTimeout(() => {
    const fresh = calls.get(e.call_id);
    if (!fresh || fresh.result_fetched) return;
    void deps
      .dispatchWakeTurn({ agent: fresh.from_agent, session: fresh.from_session!, text: askWakePrompt(fresh) })
      .catch(() => {
        /* the asker's session may be gone; the result stays fetchable */
      });
  }, deps.graceMs);
  timer.unref?.();
}

const MAX_ENTRIES = 500;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

const calls = new Map<string, AskCallEntry>();

function prune(): void {
  const now = Date.now();
  for (const [id, e] of calls) {
    if (e.finished_at !== undefined && now - e.finished_at > TERMINAL_TTL_MS) calls.delete(id);
  }
  if (calls.size <= MAX_ENTRIES) return;
  // Oldest terminal entries first; running ones are never evicted.
  const terminal = [...calls.values()]
    .filter((e) => e.finished_at !== undefined)
    .sort((a, b) => a.finished_at! - b.finished_at!);
  for (const e of terminal) {
    if (calls.size <= MAX_ENTRIES) break;
    calls.delete(e.call_id);
  }
}

export function registerAskCall(
  entry: Omit<AskCallEntry, 'state' | 'started_at' | 'finished_at' | 'result' | 'error'>,
): AskCallEntry {
  prune();
  const stored: AskCallEntry = { ...entry, state: 'queued', started_at: Date.now() };
  calls.set(entry.call_id, stored);
  return stored;
}

export function markAskCallRunning(call_id: string): void {
  const e = calls.get(call_id);
  if (e && e.state === 'queued') e.state = 'running';
}

export function completeAskCall(call_id: string, result: ChatTurnResult): void {
  const e = calls.get(call_id);
  if (!e || e.finished_at !== undefined) return;
  e.state = result.error ? 'failed' : 'done';
  e.result = result;
  e.finished_at = Date.now();
  if (result.error) e.error = result.error;
  scheduleAskWake(e);
}

export function failAskCall(call_id: string, error: string): void {
  const e = calls.get(call_id);
  if (!e || e.finished_at !== undefined) return;
  e.state = 'failed';
  e.error = error;
  e.finished_at = Date.now();
  // A failure is news too: the asker planned on an answer.
  scheduleAskWake(e);
}

export function getAskCall(call_id: string): AskCallEntry | undefined {
  const e = calls.get(call_id);
  // Reading a finished call IS fetching it: no wake afterwards, or the
  // asker is told twice about an answer it already has.
  if (e?.finished_at !== undefined) e.result_fetched = true;
  return e;
}

/** Poll until the call reaches a terminal state or `timeoutMs` passes.
 *  Same 200ms cadence as waitForTaskCompletion — the caller blocks
 *  server-side instead of burning agent-loop rounds. */
export async function waitForAskCall(call_id: string, timeoutMs: number): Promise<AskCallEntry | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = calls.get(call_id);
    if (!e) return null;
    if (e.finished_at !== undefined) return e;
    await new Promise((r) => setTimeout(r, 200));
  }
  return calls.get(call_id) ?? null;
}
