// Where a turn came from — the structured `origin` the server sends on
// every `user_message` (live SSE event and /chat/history row) since
// 2026-09-13. Client copy of src/types/turn-origin.ts; keep in sync.
//
// Turns recorded before that date carry NO origin, only the legacy
// `from_agent` / `from_session` / `from_system` fields, so every
// renderer falls back to those (see lib/origin.ts).

export interface TurnOriginRef {
  agent: string;
  session: string;
}

export type TurnOrigin =
  /** A person typed (`chat`) or dictated (`voice-stt`). */
  | { kind: 'human'; via: 'chat' | 'voice-stt' }
  /** Another agent wrote this turn (agent_ask). */
  | { kind: 'agent'; from: { agent: string; session?: string }; callId?: string }
  /** A spawned sub-agent working a sealed brief in its own session. */
  | { kind: 'subagent'; parent?: TurnOriginRef; taskId?: string; depth: number }
  /** A sentinel timer fired. */
  | { kind: 'sentinel'; triggerId: string; taskId: string }
  /** A tmux session the agent started went running → ready. */
  | { kind: 'tmux'; tmuxSession: string; tmuxKind?: string }
  /** The person handed a browser window back to the agent. */
  | { kind: 'browser'; viewId: string; cause: 'handoff' | 'activity'; handoffId?: string }
  /** The voice self of a realtime call asked the agent (consult). */
  | { kind: 'voice'; callId?: string; consultId: string }
  /** Something the agent started earlier finished and brings it back:
   *  a late agent_ask answer (`a2a`, ref = call_id), a finished async
   *  sub (`subagent`, ref = task_id), a rendered video (`job`, ref =
   *  job id). */
  | { kind: 'wake'; about: 'a2a' | 'subagent' | 'job'; ref: string; depth?: number };

export type TurnOriginKind = TurnOrigin['kind'];

/** The legacy `from_system` marker, derived server-side from `origin`:
 *  sentinel/tmux/browser/voice keep their word, a wake carries its
 *  `about`. Human, agent and subagent turns have none. */
export type FromSystem = 'sentinel' | 'tmux' | 'subagent' | 'job' | 'browser' | 'voice' | 'a2a';
