// Helpers around TurnOrigin (src/types/turn-origin.ts): the mapping to
// the legacy per-field attribution that stored sessions, SSE consumers
// and engine adapters read, the queue label, and a short name for logs.

import type { TurnOrigin } from '../types/turn-origin.ts';

export type { TurnOrigin, TurnOriginKind, TurnOriginRef } from '../types/turn-origin.ts';

export type FromSystem = 'sentinel' | 'tmux' | 'subagent' | 'job' | 'browser' | 'voice' | 'a2a';

export interface LegacyOriginFields {
  fromAgent?: string;
  fromSession?: string;
  fromSystem?: FromSystem;
  agentAskCallId?: string;
  subagentDepth?: number;
}

/**
 * The stored / streamed fields a TurnOrigin stands for. This table IS
 * the compatibility contract: an old client, an old session file and an
 * engine adapter see exactly what they saw before origins existed.
 *
 *   human               → nothing
 *   agent               → from_agent, from_session (when known), agent_ask_call_id (when known)
 *   subagent            → subagentDepth only (a brief is neutral, never labelled — Juni-Audit 2026-07)
 *   sentinel/tmux/browser/voice → from_system = kind
 *   wake                → from_system = about ('a2a' | 'subagent' | 'job'), subagentDepth when carried
 */
export function originToLegacy(origin: TurnOrigin): LegacyOriginFields {
  switch (origin.kind) {
    case 'human':
      return {};
    case 'agent':
      return {
        fromAgent: origin.from.agent,
        ...(origin.from.session ? { fromSession: origin.from.session } : {}),
        ...(origin.callId ? { agentAskCallId: origin.callId } : {}),
      };
    case 'subagent':
      return origin.depth > 0 ? { subagentDepth: origin.depth } : {};
    case 'sentinel':
    case 'tmux':
    case 'browser':
    case 'voice':
      return { fromSystem: origin.kind };
    case 'wake':
      return {
        fromSystem: origin.about,
        ...(origin.depth && origin.depth > 0 ? { subagentDepth: origin.depth } : {}),
      };
  }
}

/** Queue label for /health and logs. Order is FIFO regardless; the label
 *  says who is waiting (session-queue.ts). */
export function originLabel(origin: TurnOrigin): 'user' | 'agent' {
  return origin.kind === 'human' ? 'user' : 'agent';
}

/** One token for a log line: `human`, `agent`, `wake:a2a`, … */
export function originKind(origin: TurnOrigin): string {
  return origin.kind === 'wake' ? `wake:${origin.about}` : origin.kind;
}

/** The registry id a turn runs under, when it has one — the agent_ask
 *  call_id or the spawn task_id. Carried into the session lock so
 *  /health shows it while the turn runs. */
export function originCallId(origin: TurnOrigin): string | undefined {
  if (origin.kind === 'agent') return origin.callId;
  if (origin.kind === 'subagent') return origin.taskId;
  if (origin.kind === 'sentinel') return origin.taskId;
  return undefined;
}
