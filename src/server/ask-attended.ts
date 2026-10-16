// When an agent may ask the person a question with options (ask_user).
// Only while someone watches: a builder by its attended switch
// (builder-session.ts); any other agent in a turn a person started —
// typed or spoken. A turn from Sentinel, another agent or a sub-agent
// gets no ask_user: nobody would answer, and the session would wait
// until the question times out.
//
// run-turn writes `turnAttended` into the session meta before the engine
// starts, so the MCP child (claude-cli, codex-cli, grok-cli) reads the
// same answer the openai-compatible path uses.

import type { TurnOrigin } from '../types/turn-origin.ts';
import { builderSessionAllows, type BuilderSessionState } from './builder-session.ts';

export const TURN_ATTENDED_KEY = 'turnAttended';

/** How long a chat agent's question waits by default (a builder's: 30 min). */
export const CHAT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

/** A person started this turn (typed or spoken). A turn without a
 *  recorded origin does not count: when in doubt, nobody is watching. */
export function isAttendedOrigin(origin: TurnOrigin | undefined): boolean {
  return origin?.kind === 'human';
}

/** Whether this session offers `toolName` right now, on top of the
 *  persona's gating: a builder's mode and phase, a chat agent's
 *  ask_user only in a turn a person started. */
export function sessionToolAllows(kind: 'chat' | 'builder' | undefined, builderState: BuilderSessionState | null, meta: Record<string, unknown>, toolName: string): boolean {
  if (kind === 'builder') return builderSessionAllows(builderState, toolName);
  if (toolName === 'ask_user') return meta[TURN_ATTENDED_KEY] === true;
  return true;
}
