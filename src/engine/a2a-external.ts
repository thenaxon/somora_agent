// Engine for work handed to external agents over A2A (docs/a2a.md): one
// somora turn = one A2A task. A somora agent asks an external agent
// (agent_ask) or spawns it as a sub-agent; the turn sends the task, follows
// it to its end and writes the answer into the external agent's somora
// session, so the person can read along there. Chat with the person keeps
// using ACP (acp-external.ts).
//
// Each somora session is one A2A conversation (`contextId`): the same
// session keeps the other side's memory of earlier tasks, a fresh session
// (a sub-agent's, or after a reset) starts a fresh one.

import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from '../config/types.ts';
import { A2AError, getCard, runTask, type TaskOutcome } from '../a2a/client.ts';
import { acquireSlot, takeDailyCall } from '../a2a/limits.ts';
import { A2A_ENGINE, type TaskState } from '../a2a/protocol.ts';
import type { ExternalAgent } from '../external/registry.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { SessionMetaStore } from './types.ts';

export const A2A_CONTEXT_KEY = 'a2aContextId';

export interface A2ATurnInput {
  ext: ExternalAgent;
  /** somora session id. */
  session: string;
  text: string;
  signal?: AbortSignal;
  metaStore: SessionMetaStore;
  config: () => Config;
}

/** The A2A conversation of a somora session, made on first use. Random,
 *  so two somora installs talking to the same agent never share one. */
async function contextIdFor(metaStore: SessionMetaStore, agent: string, session: string): Promise<string> {
  const meta = await metaStore.get(agent, session);
  const known = (meta as Record<string, unknown>)[A2A_CONTEXT_KEY];
  if (typeof known === 'string' && known) return known;
  const fresh = `somora-${session.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 60)}-${randomBytes(4).toString('hex')}`;
  await metaStore.update(agent, session, (m) => ({ ...m, [A2A_CONTEXT_KEY]: fresh }));
  return fresh;
}

const STATE_TEXT: Partial<Record<TaskState, string>> = {
  submitted: 'accepted',
  working: 'working',
};

export async function* runA2ATurn(input: A2ATurnInput): AsyncGenerator<NormalizedEvent> {
  const { ext, session, metaStore } = input;
  const a2a = ext.agent.a2a;
  const cfg = input.config().external.a2a;
  const turnId = `t-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ts = () => Date.now();
  const meta = (text: string, extra: Record<string, unknown> = {}): NormalizedEvent => ({ kind: 'engine_meta', ts: ts(), engine: A2A_ENGINE, itemType: 'a2a_task', payload: { text, ...extra } });
  const end = (): NormalizedEvent => ({ kind: 'turn_end', ts: ts(), engine: A2A_ENGINE, turnId });
  const fail = (message: string): NormalizedEvent => ({ kind: 'error', ts: ts(), engine: A2A_ENGINE, message, providerError: true });
  yield { kind: 'turn_start', ts: ts(), engine: A2A_ENGINE, turnId };

  if (!a2a) {
    yield fail(`${ext.name} has no A2A access configured`);
    yield end();
    return;
  }

  const started = Date.now();
  const daily = takeDailyCall(cfg.maxCallsPerDay);
  if (!daily.ok) {
    logger.warn({ msg: 'a2a.daily_limit', agent: ext.name, session, limit: cfg.maxCallsPerDay });
    yield fail(`daily limit for external agents reached (${cfg.maxCallsPerDay} tasks, external.a2a.maxCallsPerDay) — try again tomorrow or raise the limit`);
    yield end();
    return;
  }

  // Events from callbacks (status, streamed text) reach the generator
  // through this queue.
  const queue: NormalizedEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (ev: NormalizedEvent) => {
    queue.push(ev);
    wake?.();
  };

  let release: (() => void) | null = null;
  try {
    release = await acquireSlot(ext.name, cfg.maxConcurrentPerAgent, input.signal, (ahead) => {
      push(meta(`waiting for a free slot — ${ext.name} works on ${cfg.maxConcurrentPerAgent} task${cfg.maxConcurrentPerAgent === 1 ? '' : 's'} at a time (${ahead} waiting)`));
    });
  } catch {
    while (queue.length) yield queue.shift()!;
    yield { kind: 'assistant_message', ts: ts(), engine: A2A_ENGINE, text: '[somora] stopped' };
    yield end();
    return;
  }
  while (queue.length) yield queue.shift()!;

  let outcome: TaskOutcome | null = null;
  let error: A2AError | Error | null = null;
  let streamed = '';
  let sentText = '';
  let done = false;
  try {
    const card = await getCard(a2a.url, { ...(a2a.token ? { token: a2a.token } : {}), maxAgeMs: cfg.cardRefreshMinutes * 60_000, ...(input.signal ? { signal: input.signal } : {}) });
    const contextId = await contextIdFor(metaStore, ext.name, session);
    yield meta(`sent to ${ext.name} over A2A${card.streaming ? '' : ' — it does not stream, somora checks its progress'}`, { contextId, endpoint: card.endpoint });
    const run = runTask({
      card,
      ...(a2a.token ? { token: a2a.token } : {}),
      text: input.text,
      contextId,
      ...(input.signal ? { signal: input.signal } : {}),
      maxMs: cfg.maxTaskMinutes * 60_000,
      pollMaxMs: cfg.pollMaxSeconds * 1000,
      onText: (t) => {
        // Streamed text grows; the chat gets the new piece.
        if (t.startsWith(streamed)) {
          const piece = t.slice(streamed.length);
          if (piece) push({ kind: 'assistant_delta', ts: ts(), engine: A2A_ENGINE, text: piece });
        } else {
          push({ kind: 'assistant_delta', ts: ts(), engine: A2A_ENGINE, text: `\n${t}` });
        }
        streamed = t;
      },
      onStatus: (state, said, taskId) => {
        const label = STATE_TEXT[state] ?? state;
        push(meta(said ? `${label}: ${said.slice(0, 300)}` : label, { state, ...(taskId ? { taskId } : {}) }));
      },
    }).then(
      (o) => {
        outcome = o;
      },
      (err: unknown) => {
        error = err as Error;
      },
    ).finally(() => {
      done = true;
      wake?.();
    });
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      yield queue.shift()!;
    }
    await run;
  } catch (err) {
    error = err as Error;
  } finally {
    release?.();
  }

  const o = outcome as TaskOutcome | null;
  const e = error as A2AError | Error | null;
  if (e) {
    const kind = e instanceof A2AError ? e.kind : 'error';
    if (kind === 'aborted') {
      sentText = '[somora] stopped';
      yield { kind: 'assistant_message', ts: ts(), engine: A2A_ENGINE, text: sentText };
    } else {
      yield fail(`${ext.name} (A2A): ${e.message}`);
    }
  } else if (o) {
    switch (o.state) {
      case 'completed':
        sentText = o.text.trim() || streamed.trim();
        if (sentText) yield { kind: 'assistant_message', ts: ts(), engine: A2A_ENGINE, text: sentText };
        else yield fail(`${ext.name} finished the task without an answer`);
        break;
      case 'input_required':
      case 'auth_required':
        sentText =
          `${o.text.trim() || `${ext.name} needs more information.`}\n\n` +
          `[${ext.name} needs an answer before it goes on — reply with agent_ask to ${ext.name} in this same session; the conversation continues]`;
        yield meta(o.state === 'auth_required' ? `${ext.name} needs a login on its side` : `${ext.name} asks back`, { state: o.state, ...(o.taskId ? { taskId: o.taskId } : {}) });
        yield { kind: 'assistant_message', ts: ts(), engine: A2A_ENGINE, text: sentText };
        break;
      case 'canceled': {
        const timedOut = /^gave up/.test(o.text);
        const confirmed = o.cancelConfirmed === true;
        const tail = confirmed ? `${ext.name} confirmed the stop` : `${ext.name} may still finish it on its side`;
        if (timedOut) {
          yield fail(`${ext.name} did not finish within ${cfg.maxTaskMinutes} min (external.a2a.maxTaskMinutes); somora stopped following it — ${tail}`);
        } else {
          sentText = streamed.trim() ? `${streamed.trimEnd()}\n\n[somora] stopped — ${tail}` : `[somora] stopped — ${tail}`;
          yield { kind: 'assistant_message', ts: ts(), engine: A2A_ENGINE, text: sentText };
        }
        break;
      }
      case 'rejected':
        yield fail(`${ext.name} refused the task${o.text.trim() ? `: ${o.text.trim()}` : ''}`);
        break;
      default:
        yield fail(`${ext.name} could not do the task${o.text.trim() ? `: ${o.text.trim()}` : ''}`);
    }
  }
  yield end();
  logger.info({
    msg: 'a2a.task',
    agent: ext.name,
    system: ext.system,
    session,
    state: o?.state ?? (e ? `error:${e instanceof A2AError ? e.kind : 'other'}` : 'none'),
    ...(o?.taskId ? { taskId: o.taskId } : {}),
    ms: Date.now() - started,
    answerLen: sentText.length,
    daily: daily.count,
    ...(e ? { err: e.message } : {}),
  });
}
