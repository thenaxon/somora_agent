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
/** Who started the running turn when someone watches: `human` or `peer`
 *  (null otherwise). Decides whether a chat agent's question waits. */
export const TURN_ASKER_KEY = 'turnAskedBy';

/** How long a chat agent's question waits by default (a builder's: 30 min). */
export const CHAT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

/** Someone waits for this turn who can answer a question: a person who
 *  typed or spoke, or another agent system that sent the task over A2A
 *  (its question goes back to it as input-required, docs/a2a.md). A turn
 *  without a recorded origin does not count: when in doubt, nobody is
 *  watching. */
export function isAttendedOrigin(origin: TurnOrigin | undefined): boolean {
  return origin?.kind === 'human' || origin?.kind === 'peer';
}

/** Who can answer a question in a turn from `origin`. */
export function askerOf(origin: TurnOrigin | undefined): 'human' | 'peer' | null {
  return origin?.kind === 'human' ? 'human' : origin?.kind === 'peer' ? 'peer' : null;
}

/** A chat agent's question in a turn a person started does not wait:
 *  the turn ends, and the answer comes as the person's next message
 *  (async-questions.ts). A builder's question and one in a task from
 *  another agent system wait in the turn (builder-questions.ts). */
export function asksWithoutWaiting(kind: 'chat' | 'builder' | undefined, meta: Record<string, unknown>): boolean {
  return kind !== 'builder' && meta[TURN_ATTENDED_KEY] === true && meta[TURN_ASKER_KEY] === 'human';
}

/** Whether this session offers `toolName` right now, on top of the
 *  persona's gating: a builder's mode and phase, a chat agent's
 *  ask_user only in a turn a person started. */
export function sessionToolAllows(kind: 'chat' | 'builder' | undefined, builderState: BuilderSessionState | null, meta: Record<string, unknown>, toolName: string): boolean {
  if (kind === 'builder') return builderSessionAllows(builderState, toolName);
  if (toolName === 'ask_user') return meta[TURN_ATTENDED_KEY] === true;
  return true;
}
