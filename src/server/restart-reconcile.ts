// What a server restart cut off, made visible at the next boot.
//
// A turn that was running when the process died leaves its session
// ending in `turn_start` / `tool_call` with no `turn_end`: the window
// shows it as still running, the model's history carries a tool call
// without its result, and whoever asked for that turn (an agent_ask
// without waiting, a builder_dispatch, a parent of a helper) waits for
// a wake that the in-memory registries can no longer send. Hardening
// test 2026-09-23: none of the four askers ever heard of the restart.
//
// At boot, every session file's tail is read; an open turn gets an
// `error` + `turn_end` marker, and the caller learns which askers to
// wake (the user_message of the cut turn carries its origin).

import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendEvent } from '../storage/sessions.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { logger } from './logger.ts';

export const RESTART_NOTE = '[somora] This turn was interrupted by a server restart; the work it was doing stopped here.';
const TAIL_BYTES = 128 * 1024;

export interface InterruptedTurn {
  agent: string;
  session: string;
  turnId: string;
  startedAt: number;
  /** The agent that asked for the turn, when one did (agent_ask, builder_dispatch). */
  fromAgent?: string;
  fromSession?: string;
  callId?: string;
  /** The parent of a helper turn, when this was one. */
  parent?: { agent: string; session: string };
}

async function readTail(path: string): Promise<Record<string, unknown>[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const out: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* a half-written last line: ignore */
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** The open turn at the end of `rows`, or null. */
export function openTurnOf(rows: Record<string, unknown>[]): Omit<InterruptedTurn, 'agent' | 'session'> | null {
  let startIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = rows[i]!.kind;
    if (k === 'turn_end') return null;
    if (k === 'turn_start') {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  const start = rows[startIdx]!;
  const t: Omit<InterruptedTurn, 'agent' | 'session'> = {
    turnId: typeof start.turnId === 'string' ? start.turnId : `t-${start.ts}`,
    startedAt: typeof start.ts === 'number' ? start.ts : Date.now(),
  };
  for (let i = startIdx - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind !== 'user_message') continue;
    if (typeof r.from_agent === 'string') t.fromAgent = r.from_agent;
    if (typeof r.from_session === 'string') t.fromSession = r.from_session;
    if (typeof r.agent_ask_call_id === 'string') t.callId = r.agent_ask_call_id;
    const origin = r.origin as { kind?: string; parent?: { agent?: string; session?: string } } | undefined;
    if (origin?.kind === 'subagent' && origin.parent?.agent && origin.parent?.session) {
      t.parent = { agent: origin.parent.agent, session: origin.parent.session };
    }
    break;
  }
  return t;
}

/** Find every open turn across the agents' sessions and close it with a
 *  marker. Returns what was closed, so the caller can wake the askers. */
export async function reconcileInterruptedTurns(agents: readonly string[]): Promise<InterruptedTurn[]> {
  const found: InterruptedTurn[] = [];
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  for (const agent of agents) {
    const dir = join(home, 'agents', agent, 'sessions');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const id = file.slice(0, -'.jsonl'.length);
      let rows: Record<string, unknown>[];
      try {
        rows = await readTail(join(dir, file));
      } catch {
        continue;
      }
      const open = openTurnOf(rows);
      if (!open) continue;
      const t: InterruptedTurn = { agent, session: id, ...open };
      const ts = Date.now();
      await appendEvent(agent, id, { kind: 'error', ts, engine: 'somora', message: RESTART_NOTE } as NormalizedEvent);
      await appendEvent(agent, id, { kind: 'turn_end', ts, engine: 'somora', turnId: t.turnId, interrupted: 'server_restart' } as unknown as NormalizedEvent);
      logger.warn({ msg: 'restart.turn_interrupted', agent, session: id, turnId: t.turnId, startedAt: new Date(t.startedAt).toISOString(), fromAgent: t.fromAgent ?? null, callId: t.callId ?? null, parent: t.parent ?? null });
      found.push(t);
    }
  }
  return found;
}

/** The wake text for an asker whose question died with the restart. */
export function restartWakeText(t: InterruptedTurn): string {
  return (
    `[agent answer] The question you sent to ${t.agent} (session '${t.session}') was cut off by a server restart before an answer came` +
    (t.callId ? ` (call_id "${t.callId}")` : '') +
    '. It will not be answered on its own — send it again if you still need it.'
  );
}

export function restartParentWakeText(t: InterruptedTurn): string {
  return `[subagent attention] The helper in ${t.agent}'s session '${t.session}' was cut off by a server restart before it finished; there is no result. Start it again if you still need it.`;
}
