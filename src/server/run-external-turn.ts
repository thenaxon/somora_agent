// A turn of an external agent (docs/external-agents.md). runChatTurn hands
// over here at its very start, so none of its preparation for somora's own
// agents — persona prompt, memory, tools, fallback models, builder state —
// touches an external agent, and none of this touches them. What both
// share is the plumbing: the session file, the live stream to every open
// window (same serializer, same events), the result shape.

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { readFile } from 'node:fs/promises';
import { resolveAttachmentForModel } from '../attachments/store.ts';
import { ACP_ENGINE } from '../acp/translate.ts';
import { runExternalTurn } from '../engine/acp-external.ts';
import type { ExternalAgent } from '../external/registry.ts';
import { appendEvent, getHistory } from '../storage/sessions.ts';
import { askQuestion, dropQuestions } from './builder-questions.ts';
import { healOrphanToolCalls } from './heal-session.ts';
import { logger } from './logger.ts';
import type { ChatTurnResult, RunChatTurnArgs } from './run-turn.ts';
import { config as liveConfig } from './server-state.ts';
import { createTurnSerializer } from './sse-serializer.ts';

export async function runExternalChatTurn(args: RunChatTurnArgs, ext: ExternalAgent, turnId: string): Promise<ChatTurnResult> {
  const start = Date.now();
  const { agent, session, text, publishSse, signal, deps } = args;
  const provider = 'external';
  const model = `${ext.system}/${ext.name}`;

  if (args.fromAgent) {
    // Agents asking external agents comes with A2A (a later step): no
    // wait graph across systems yet, no loop or cost brake.
    throw new Error(`'${agent}' is an external agent (${ext.system}); somora agents cannot ask it yet`);
  }

  try {
    await healOrphanToolCalls({ agent, session, history: await getHistory(agent, session), metaStore: deps.sessionMetaStore, fallbackEngine: ACP_ENGINE });
  } catch (err) {
    logger.warn({ msg: 'session.heal_failed', agent, session, err: (err as Error).message });
  }

  // Images go along when the agent takes them; anything else is refused
  // before the turn, like for a somora model without that capability.
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const a of args.attachments ?? []) {
    const r = await resolveAttachmentForModel({ hash: a.hash, expectedMime: a.mime, maxImageEdge: deps.config.attachments.maxImageEdge });
    if (r.mime.kind !== 'image') throw new Error(`${agent} is an external agent and takes only images as attachments (${a.name} is ${r.mime.kind})`);
    images.push({ mimeType: r.mime.mimeType, data: (await readFile(r.path)).toString('base64') });
  }

  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: ACP_ENGINE,
    text,
    ...(args.origin ? { origin: args.origin } : {}),
    ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
  });
  if (publishSse) {
    await publishSse({ event: 'user_message', data: { text, ts: Date.now(), turnId, ...(args.origin ? { origin: args.origin } : {}) } });
    await publishSse({ event: 'agent', data: { phase: 'start', provider, model, external: { system: ext.system } } });
  }

  const onPermission = async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const cfg = liveConfig;
    const options = req.options.slice(0, 6);
    let lastQuestionId: string | undefined;
    const detail = describeToolCall(req.toolCall);
    const answer = await askQuestion(
      {
        agent,
        session,
        question: detail ? `${ext.name} asks for permission: ${detail}` : `${ext.name} asks for permission`,
        header: 'Permission',
        options: options.map((o) => ({ label: o.name, description: o.kind })),
        multiple: false,
        timeoutMs: cfg.external.questionTimeoutMinutes * 60_000,
      },
      (q) => {
        lastQuestionId = q.id;
        if (!publishSse) return;
        void publishSse({
          event: 'question_asked',
          data: { questionId: q.id, question: q.question, header: q.header, options: q.options, multiple: false, expiresAt: q.expiresAt, kind: 'permission', from: 'external' },
        });
      },
    );
    const picked = answer.answered ? options.find((o) => o.name === answer.answers[0]) : undefined;
    if (publishSse) void publishSse({ event: 'question_answered', data: { questionId: lastQuestionId, answered: answer.answered, choice: picked?.name ?? null } });
    if (!picked) {
      // Unanswered (time ran out, turn stopped): the safest choice.
      const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
      logger.info({ msg: 'external.permission', agent, session, answered: false, chose: reject?.optionId ?? 'cancelled' });
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    logger.info({ msg: 'external.permission', agent, session, answered: true, chose: picked.optionId, kind: picked.kind });
    return { outcome: { outcome: 'selected', optionId: picked.optionId } };
  };

  const serialize = publishSse ? createTurnSerializer() : null;
  let finalText = '';
  let toolCalls = 0;
  let errorMessage: string | undefined;
  let lastUsage: ChatTurnResult['usage'];
  let streamTurnId: string | undefined;
  let sawTurnEnd = false;
  let degraded: string | undefined;
  try {
    for await (const ev of runExternalTurn({
      ext,
      session,
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(signal ? { signal } : {}),
      metaStore: deps.sessionMetaStore,
      config: () => liveConfig,
      onPermission,
    })) {
      if (ev.kind === 'thinking_delta' || ev.kind === 'thinking_message') {
        if (!deps.config.thinkingContent.capture) continue;
        if (ev.kind === 'thinking_message' && ev.text.length > deps.config.thinkingContent.maxChars) {
          ev.text = ev.text.slice(0, deps.config.thinkingContent.maxChars).trimEnd() + '…';
          ev.truncated = true;
        }
      }
      if (ev.kind === 'turn_end') {
        ev.model = `${provider}/${model}`;
        sawTurnEnd = true;
        if (ev.usage) lastUsage = ev.usage;
        if (ev.degraded) degraded = ev.degraded.reason;
      }
      if (ev.kind !== 'assistant_delta' && ev.kind !== 'thinking_delta') await appendEvent(agent, session, ev);
      if (ev.kind === 'turn_start') {
        streamTurnId = ev.turnId;
        if (publishSse) await publishSse({ event: 'turn_started', data: { turnId: ev.turnId } });
      }
      if (ev.kind === 'tool_call') toolCalls += 1;
      if (ev.kind === 'error' && !errorMessage) errorMessage = ev.message;
      if (ev.kind === 'assistant_message') finalText = ev.text;
      if (serialize && publishSse) {
        const sse = serialize(ev);
        if (sse) await publishSse(sse);
        if (ev.kind === 'error') {
          await publishSse({ event: 'turn_error', data: { ...(streamTurnId ? { turnId: streamTurnId } : {}), message: ev.message, engine: ev.engine } });
        }
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    logger.error({ msg: 'external.turn_failed', turnId, agent, session, err: errorMessage });
    await appendEvent(agent, session, { kind: 'error', ts: Date.now(), engine: ACP_ENGINE, message: errorMessage, providerError: true });
    if (publishSse) await publishSse({ event: 'turn_error', data: { ...(streamTurnId ? { turnId: streamTurnId } : {}), message: errorMessage, engine: ACP_ENGINE } });
  } finally {
    dropQuestions(agent, session);
  }
  if (!sawTurnEnd) {
    await appendEvent(agent, session, { kind: 'turn_end', ts: Date.now(), engine: ACP_ENGINE, turnId: streamTurnId ?? `t-${Date.now()}`, model: `${provider}/${model}` });
  }
  const contextWindow = lastUsage?.context_window ?? 0;
  if (publishSse) {
    await publishSse({ event: 'agent', data: { phase: 'end', ...(lastUsage ? { usage: lastUsage } : {}), contextWindow, provider, model, external: { system: ext.system } } });
  }
  logger.info({ msg: errorMessage ? 'turn.ended_degraded' : 'turn.completed', turnId, agent, session, external: ext.system, ms: Date.now() - start, finalTextLen: finalText.length, ...(errorMessage ? { err: errorMessage } : {}) });
  const outcome = errorMessage ? 'failed' : degraded || !finalText.trim() ? 'degraded' : 'completed';
  return {
    finalText,
    outcome,
    ...(outcome === 'degraded' ? { outcome_reason: degraded ?? 'empty_answer' } : {}),
    tool_calls: toolCalls,
    ...(lastUsage ? { usage: lastUsage } : {}),
    contextWindow,
    provider,
    model,
    thinkingActive: false,
    ms: Date.now() - start,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

function describeToolCall(tc: RequestPermissionRequest['toolCall']): string {
  const title = typeof tc.title === 'string' ? tc.title : '';
  const raw = tc.rawInput as { command?: unknown } | undefined;
  const cmd = raw && typeof raw.command === 'string' ? raw.command : '';
  return (title || cmd).slice(0, 300);
}
