// Where a turn came from — ONE value instead of six loose fields.
//
// Every turn in somora used to say who started it through some mix of
// from_agent / from_session / from_system / agent_ask_call_id /
// subagentDepth / turnPrefix, set in fourteen different call sites in
// fourteen slightly different combinations (private/turn-triggers-
// birdseye.md, 2026-09-13). This type is the single answer. It travels
// on the stored user_message and on the SSE user_message event as
// `origin`, and clients render glyph, label and subtitle from it —
// no more regex over the message text.
//
// The legacy fields stay, derived from this (src/server/turn-origin-
// kind.ts → originToLegacy), so every stored session, every third-
// party client and every agent prompt keeps working unchanged.
//
// Lives in src/types so the event types can reference it without a
// dependency on the server layer.

export interface TurnOriginRef {
  agent: string;
  session: string;
}

export type TurnOrigin =
  /** A person typed (`chat`) or dictated (`voice-stt`, /voice/turn and
   *  the microphone button). */
  | { kind: 'human'; via: 'chat' | 'voice-stt' }
  /** Another agent wrote this turn (agent_ask). `from.session` is the
   *  session it wrote from — absent when the caller did not say (a
   *  third-party client posting from_agent to /chat/send). `callId`
   *  correlates with agent_ask_result. */
  | { kind: 'agent'; from: { agent: string; session?: string }; callId?: string }
  /** A spawned sub-agent working a sealed brief in its own session.
   *  `parent` is who spawned it (unknown on a bare /chat/send-sync
   *  without waiter fields), `taskId` only for async spawns. */
  | { kind: 'subagent'; parent?: TurnOriginRef; taskId?: string; depth: number }
  /** A sentinel timer fired. `taskId` is the fire's id in the task
   *  registry and in the trigger's history. */
  | { kind: 'sentinel'; triggerId: string; taskId: string; triggerName?: string }
  /** A tmux session the agent started went running → ready. */
  | { kind: 'tmux'; tmuxSession: string; tmuxKind?: string }
  /** The person handed a browser window back to the agent. */
  | { kind: 'browser'; viewId: string; cause: 'handoff' | 'activity'; handoffId?: string }
  /** The voice self of a realtime call asked the agent (consult). */
  | { kind: 'voice'; callId?: string; consultId: string }
  /** Something the agent started earlier finished and brings it back:
   *  a late agent_ask answer (`a2a`, ref = call_id), a finished async
   *  sub (`subagent`, ref = task_id), a rendered video (`job`, ref =
   *  job id). `depth` keeps a sub-orchestrator's nesting level across
   *  the wake. */
  | { kind: 'wake'; about: 'a2a' | 'subagent' | 'job'; ref: string; depth?: number };

export type TurnOriginKind = TurnOrigin['kind'];
