// Messages an external agent sends on its own, between turns
// (docs/external-agents.md#messages-it-sends-on-its-own): the result of a
// sub-task it started, a reminder, anything its system pushes after the
// turn ended. ACP delivers them as session updates with no prompt
// running; they used to be dropped.
//
// They are collected per session until the agent has been quiet for a
// moment, then written into the session like an answer — with a note
// that the agent wrote on its own — and shown in every open client. A
// turn starting in that session first writes what was collected.

import { randomUUID } from 'node:crypto';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { ACP_ENGINE, AcpTurnTranslator } from '../acp/translate.ts';
import { logger } from '../server/logger.ts';
import { createTurnSerializer } from '../server/sse-serializer.ts';
import { appendEvent } from '../storage/sessions.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import type { ExternalAgent } from './registry.ts';
import { setUnpromptedSink } from './connection.ts';

/** How long the agent must be quiet before what it sent is written. */
export const UNPROMPTED_QUIET_MS = 2_000;

interface Pending {
  ext: ExternalAgent;
  session: string;
  turnId: string;
  tr: AcpTurnTranslator;
  events: NormalizedEvent[];
  timer: NodeJS.Timeout | null;
  first: number;
}

const pending = new Map<string, Pending>();
/** A write running now, per session: a turn waits for it. */
const writing = new Map<string, Promise<void>>();
const key = (agent: string, session: string) => `${agent}/${session}`;
let publish: ((agent: string, session: string, e: SseEvent) => Promise<void> | void) | null = null;

/** Server boot: start collecting, and where to show what comes. */
export function configureUnprompted(deps: { publish: (agent: string, session: string, e: SseEvent) => Promise<void> | void; quietMs?: number; graceMs?: number }): void {
  publish = deps.publish;
  const quiet = deps.quietMs ?? UNPROMPTED_QUIET_MS;
  setUnpromptedSink((ext, session, update) => collect(ext, session, update, quiet), deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {});
}

function collect(ext: ExternalAgent, session: string, update: SessionUpdate, quietMs: number): void {
  const k = key(ext.name, session);
  let p = pending.get(k);
  if (!p) {
    const turnId = `t-${Date.now()}-${randomUUID().slice(0, 8)}`;
    p = { ext, session, turnId, tr: new AcpTurnTranslator(turnId), events: [], timer: null, first: Date.now() };
    pending.set(k, p);
  }
  p.events.push(...p.tr.update(update));
  if (p.timer) clearTimeout(p.timer);
  const entry = p;
  p.timer = setTimeout(() => void flush(entry), quietMs);
  p.timer.unref?.();
}

/** Write what an agent sent on its own in this session now — before a
 *  turn starts there, so the order in the session stays right. */
export async function flushUnprompted(agent: string, session: string): Promise<void> {
  const p = pending.get(key(agent, session));
  if (p) await flush(p);
  await writing.get(key(agent, session));
}

function flush(p: Pending): Promise<void> {
  const k = key(p.ext.name, p.session);
  if (pending.get(k) !== p) return writing.get(k) ?? Promise.resolve();
  pending.delete(k);
  if (p.timer) clearTimeout(p.timer);
  const before = writing.get(k) ?? Promise.resolve();
  const run = before
    .then(() => write(p))
    .catch((err) => logger.warn({ msg: 'external.unprompted_failed', agent: p.ext.name, session: p.session, err: (err as Error).message }))
    .finally(() => {
      if (writing.get(k) === run) writing.delete(k);
    });
  writing.set(k, run);
  return run;
}

async function write(p: Pending): Promise<void> {
  const body = [...p.events, ...p.tr.finish('end_turn')].filter((e) => e.kind !== 'turn_end');
  const hasContent = body.some((e) => (e.kind === 'assistant_message' && e.text.trim()) || e.kind === 'tool_call');
  if (!hasContent) return;
  const ts = Date.now();
  const note: NormalizedEvent = {
    kind: 'engine_meta',
    ts,
    engine: ACP_ENGINE,
    itemType: 'external_unprompted',
    payload: { text: `${p.ext.name} wrote this on its own, outside a turn` },
  };
  const events: NormalizedEvent[] = [
    { kind: 'turn_start', ts: p.first, engine: ACP_ENGINE, turnId: p.turnId },
    note,
    ...body,
    { kind: 'turn_end', ts, engine: ACP_ENGINE, turnId: p.turnId, model: `external/${p.ext.system}/${p.ext.name}` },
  ];
  const serialize = createTurnSerializer();
  const send = async (e: SseEvent) => {
    try {
      await publish?.(p.ext.name, p.session, e);
    } catch {
      /* a client gone does not stop the write */
    }
  };
  await send({ event: 'agent', data: { phase: 'start', provider: 'external', model: `${p.ext.system}/${p.ext.name}`, external: { system: p.ext.system, unprompted: true } } });
  for (const ev of events) {
    if (ev.kind !== 'assistant_delta' && ev.kind !== 'thinking_delta') await appendEvent(p.ext.name, p.session, ev);
    const sse = serialize(ev);
    if (sse) await send(sse);
  }
  await send({ event: 'agent', data: { phase: 'end', provider: 'external', model: `${p.ext.system}/${p.ext.name}`, contextWindow: 0, external: { system: p.ext.system, unprompted: true } } });
  const text = body.filter((e) => e.kind === 'assistant_message').map((e) => (e as { text: string }).text).join('\n');
  logger.info({ msg: 'external.unprompted', agent: p.ext.name, session: p.session, chars: text.length, events: body.length, ms: ts - p.first });
}

/** For tests. */
export function resetUnprompted(): void {
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
  pending.clear();
}
