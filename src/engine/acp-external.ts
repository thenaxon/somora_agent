// Engine for external agents (docs/external-agents.md): one somora turn =
// one ACP `session/prompt` to an agent of another system (OpenClaw,
// Hermes, …). The agent loop — thinking, tool calls, its own memory —
// runs over there, the way it runs inside Claude Code or Codex for those
// engines; this adapter only carries the prompt and turns the agent's
// updates into somora events (src/acp/translate.ts).

import { randomUUID } from 'node:crypto';
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Config } from '../config/types.ts';
import { ACP_ENGINE, AcpTurnTranslator } from '../acp/translate.ts';
import { connectionFor, rememberInfo, type ExternalConnection } from '../external/connection.ts';
import type { ExternalAgent } from '../external/registry.ts';
import { logger } from '../server/logger.ts';
import type { SessionMetaStore } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

export interface ExternalTurnInput {
  ext: ExternalAgent;
  /** somora session id. */
  session: string;
  text: string;
  /** Images to send along (base64), when the agent takes images. */
  images?: Array<{ mimeType: string; data: string }>;
  signal?: AbortSignal;
  metaStore: SessionMetaStore;
  config: () => Config;
  /** A question from the agent ("may I run this?"): ask the person. */
  onPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** Command with `{session}` / `{agent}` filled in — lets one command give
 *  every somora session its own session on the other side (OpenClaw's
 *  `--session agent:main:somora-{session}`). */
export function fillCommand(command: string, vars: { session: string; agent: string }): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '-');
  return command.replace(/\{session\}/g, safe(vars.session)).replace(/\{agent\}/g, safe(vars.agent));
}

export async function* runExternalTurn(input: ExternalTurnInput): AsyncGenerator<NormalizedEvent> {
  const { ext, session, metaStore } = input;
  const turnId = `t-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ts = () => Date.now();
  yield { kind: 'turn_start', ts: ts(), engine: ACP_ENGINE, turnId };

  const queue: NormalizedEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (evs: NormalizedEvent[]) => {
    if (evs.length === 0) return;
    queue.push(...evs);
    wake?.();
  };
  const tr = new AcpTurnTranslator(turnId);
  const started = Date.now();

  let conn: ExternalConnection;
  try {
    const meta = await metaStore.get(ext.name, session);
    // After a reset the somora session keeps its id; the generation makes
    // `{session}` new, so a system that keys sessions by the command
    // (OpenClaw's --session) starts a fresh conversation too.
    const gen = typeof (meta as { externalGeneration?: unknown }).externalGeneration === 'number' ? (meta as { externalGeneration: number }).externalGeneration : 0;
    const sessionVar = gen > 0 ? `${session}-r${gen}` : session;
    const filled = { ...ext, agent: { ...ext.agent, command: fillCommand(ext.agent.command, { session: sessionVar, agent: ext.name }) } };
    conn = await connectionFor(filled, session, input.config);
    rememberInfo(ext.name, conn.info);
    const known = typeof (meta as { externalSessionId?: unknown }).externalSessionId === 'string' ? (meta as { externalSessionId: string }).externalSessionId : undefined;
    const s = await conn.ensureSession(known, input.config());
    if (s.sessionId !== known) {
      await metaStore.update(ext.name, session, (m) => ({ ...m, externalSessionId: s.sessionId, externalSystem: ext.system }));
    }
    if (s.lostPrevious) {
      yield { kind: 'engine_meta', ts: ts(), engine: ACP_ENGINE, itemType: 'external_session_new', payload: { message: `${ext.name} no longer had the earlier session; this continues in a new one on its side.` } };
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ msg: 'external.turn_start_failed', agent: ext.name, system: ext.system, session, err: message });
    for (const e of tr.finish('error', undefined, `${ext.name} could not be reached: ${message}`)) yield e;
    return;
  }

  const blocks: ContentBlock[] = [];
  if (input.images?.length && conn.info.capabilities?.promptCapabilities?.image) {
    for (const img of input.images) blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
  }
  blocks.push({ type: 'text', text: input.text });

  let toolCalls = 0;
  let done = false;
  let outcome: { stop: Parameters<AcpTurnTranslator['finish']>[0]; usage?: Parameters<AcpTurnTranslator['finish']>[1]; error?: string } | null = null;
  const run = conn
    .prompt(
      blocks,
      {
        onUpdate: (u) => {
          if (u.sessionUpdate === 'tool_call') toolCalls += 1;
          push(tr.update(u));
        },
        onPermission: (req) => input.onPermission(req),
      },
      input.signal,
    )
    .then(
      (res) => {
        const u = res.usage as { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cachedReadTokens?: number } | undefined | null;
        outcome = {
          stop: res.stopReason,
          ...(u ? { usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, thoughtTokens: u.thoughtTokens ?? undefined, cachedReadTokens: u.cachedReadTokens ?? undefined } } : {}),
        };
      },
      (err: unknown) => {
        outcome = input.signal?.aborted ? { stop: 'cancelled' } : { stop: 'error', error: (err as Error).message ?? String(err) };
      },
    )
    .finally(() => {
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
  const o = outcome as { stop: Parameters<AcpTurnTranslator['finish']>[0]; usage?: Parameters<AcpTurnTranslator['finish']>[1]; error?: string } | null;
  for (const e of tr.finish(o?.stop ?? 'error', o?.usage, o?.error)) yield e;
  if (tr.title) {
    await metaStore.update(ext.name, session, (m) => ({ ...m, externalTitle: tr.title })).catch(() => {});
  }
  logger.info({
    msg: 'external.turn',
    agent: ext.name,
    system: ext.system,
    session,
    stopReason: o?.stop,
    ms: Date.now() - started,
    toolCalls,
    ...(o?.error ? { err: o.error } : {}),
  });
}
