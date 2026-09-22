// Messages for a turn that is already running ("steering").
//
// A message sent to a busy session used to wait in the session queue
// and become its own turn after the running one — minutes for a chat
// agent, hours for a builder. Steering hands the text to the running
// turn instead: the engine picks it up at its next step boundary
// (before the next model call, after the tools of the previous round
// returned) and the model reads it as a user message inside the turn.
//
// This module is only the letterbox: per (agent, session) a list of
// pending steer messages, and a note of which running turn can take
// them. The engines drain it (via TurnInput.steer), run-turn persists
// what was applied as ordinary `user_message` records with `steer:
// true`, and start-turn turns whatever was still pending when the turn
// ended into normal queued turns, so nothing is lost.
//
// In-memory only — a message steered into a turn that dies with the
// server was never persisted; the client still shows it and the person
// can send it again.

import { randomUUID } from 'node:crypto';
import type { TurnOrigin } from '../types/turn-origin.ts';
import { logger } from './logger.ts';

export interface SteerMessage {
  id: string;
  text: string;
  ts: number;
  origin: TurnOrigin;
  from_agent?: string;
  from_session?: string;
}

interface Steerable {
  engine: string;
  turnId: string;
}

const inbox = new Map<string, SteerMessage[]>();
const steerable = new Map<string, Steerable>();

const key = (agent: string, session: string): string => `${agent}/${session}`;

/** Engines that read the inbox between steps. grok-cli does not. */
export const STEERABLE_ENGINES: ReadonlySet<string> = new Set(['openai-compatible', 'claude-cli', 'codex-cli']);

/** Called by run-turn once the engine for a turn is known. */
export function markSteerable(agent: string, session: string, engine: string, turnId: string): void {
  if (!STEERABLE_ENGINES.has(engine)) return;
  steerable.set(key(agent, session), { engine, turnId });
}

export function unmarkSteerable(agent: string, session: string, turnId: string): void {
  const k = key(agent, session);
  if (steerable.get(k)?.turnId === turnId) steerable.delete(k);
}

/** The running turn that can take a steer message right now, if any. */
export function steerableTurn(agent: string, session: string): Steerable | null {
  return steerable.get(key(agent, session)) ?? null;
}

export function pushSteer(
  agent: string,
  session: string,
  msg: Omit<SteerMessage, 'id' | 'ts'> & { id?: string; ts?: number },
): SteerMessage {
  const full: SteerMessage = { id: msg.id ?? randomUUID(), ts: msg.ts ?? Date.now(), ...msg } as SteerMessage;
  const k = key(agent, session);
  const list = inbox.get(k) ?? [];
  list.push(full);
  inbox.set(k, list);
  logger.info({ msg: 'steer.queued', agent, session, steerId: full.id, len: full.text.length, pending: list.length });
  return full;
}

/** Everything pending, in arrival order; the inbox is empty afterwards. */
export function drainSteer(agent: string, session: string): SteerMessage[] {
  const k = key(agent, session);
  const list = inbox.get(k);
  if (!list || list.length === 0) return [];
  inbox.delete(k);
  return list;
}

/** Put messages back at the front of the line (delivery failed). */
export function requeueSteer(agent: string, session: string, msgs: SteerMessage[]): void {
  if (msgs.length === 0) return;
  const k = key(agent, session);
  inbox.set(k, [...msgs, ...(inbox.get(k) ?? [])]);
}

export function pendingSteer(agent: string, session: string): number {
  return inbox.get(key(agent, session))?.length ?? 0;
}

/** The text the model sees for a steer message: a frame that says it
 *  arrived during the work, then the message itself. */
export function frameSteerMessage(m: SteerMessage): string {
  const who = m.from_agent
    ? `agent ${m.from_agent}${m.from_session ? ` (session ${m.from_session})` : ''}`
    : 'the user';
  return (
    `[somora] Message from ${who}, sent while you were working — delivered before your next step. ` +
    `Take it into account now: change course, stop, or continue as it says.\n\n${m.text}`
  );
}
