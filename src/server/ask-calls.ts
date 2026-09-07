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
}

export function failAskCall(call_id: string, error: string): void {
  const e = calls.get(call_id);
  if (!e || e.finished_at !== undefined) return;
  e.state = 'failed';
  e.error = error;
  e.finished_at = Date.now();
}

export function getAskCall(call_id: string): AskCallEntry | undefined {
  return calls.get(call_id);
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
