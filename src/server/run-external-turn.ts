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
import { A2A_ENGINE } from '../a2a/protocol.ts';
import { runA2ATurn } from '../engine/a2a-external.ts';
import { runExternalTurn } from '../engine/acp-external.ts';
import { getResolvedTeam } from '../team/store.ts';
import { A2A_QUIET_KEY } from '../tools/gating.ts';
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

  // Work handed over by a somora agent (agent_ask, a sub-agent spawn,
  // anything not typed by a person) goes over A2A (docs/a2a.md); the
  // person's chat goes over ACP.
  const delegated = Boolean(args.fromAgent) || (args.origin !== undefined && args.origin.kind !== 'human');
  if (delegated && !ext.agent.a2a) {
    throw new Error(
      `'${agent}' is an external agent (${ext.system}) without A2A access, so somora agents cannot hand it work — ` +
        `the person can chat with it in its own window (to allow it: external.systems.${ext.system}.agents.${agent}.a2a in config.yaml, docs/a2a.md)`,
    );
  }
  if (delegated && (args.attachments?.length ?? 0) > 0) {
    throw new Error(`images and files cannot be handed to an external agent over A2A yet; describe them in the message instead`);
  }

  // Work agents hand each other carries no unread dot (like a sub-agent's
  // session); set before anything is published.
  if (delegated) {
    await deps.sessionMetaStore.update(agent, session, (m) => (m[A2A_QUIET_KEY] === true ? m : { ...m, [A2A_QUIET_KEY]: true }));
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

  // Who handed the work over, as on every other agent's session.
  const from = {
    ...(args.fromAgent ? { from_agent: args.fromAgent } : {}),
    ...(args.fromAgent && args.fromSession ? { from_session: args.fromSession } : {}),
    ...(args.fromSystem ? { from_system: args.fromSystem } : {}),
    ...(args.agentAskCallId ? { agent_ask_call_id: args.agentAskCallId } : {}),
  };
  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: delegated ? A2A_ENGINE : ACP_ENGINE,
    text,
    ...from,
    ...(args.origin ? { origin: args.origin } : {}),
    ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
  });
  if (publishSse) {
    await publishSse({ event: 'user_message', data: { text, ts: Date.now(), turnId, ...from, ...(args.origin ? { origin: args.origin } : {}) } });
    await publishSse({ event: 'agent', data: { phase: 'start', provider, model, external: { system: ext.system, ...(delegated ? { via: 'a2a' } : {}) } } });
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
    const events = delegated
      ? runA2ATurn({
          ext,
          session,
          text: await introduced(text, args, deps.config.external.a2a.introduce),
          ...(signal ? { signal } : {}),
          metaStore: deps.sessionMetaStore,
          config: () => liveConfig,
        })
      : runExternalTurn({
          ext,
          session,
          text,
          ...(images.length > 0 ? { images } : {}),
          ...(signal ? { signal } : {}),
          metaStore: deps.sessionMetaStore,
          config: () => liveConfig,
          onPermission,
        });
    for await (const ev of events) {
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
    await appendEvent(agent, session, { kind: 'error', ts: Date.now(), engine: delegated ? A2A_ENGINE : ACP_ENGINE, message: errorMessage, providerError: true });
    if (publishSse) await publishSse({ event: 'turn_error', data: { ...(streamTurnId ? { turnId: streamTurnId } : {}), message: errorMessage, engine: delegated ? A2A_ENGINE : ACP_ENGINE } });
  } finally {
    dropQuestions(agent, session);
  }
  if (!sawTurnEnd) {
    await appendEvent(agent, session, { kind: 'turn_end', ts: Date.now(), engine: delegated ? A2A_ENGINE : ACP_ENGINE, turnId: streamTurnId ?? `t-${Date.now()}`, model: `${provider}/${model}` });
  }
  const contextWindow = lastUsage?.context_window ?? 0;
  if (publishSse) {
    await publishSse({ event: 'agent', data: { phase: 'end', ...(lastUsage ? { usage: lastUsage } : {}), contextWindow, provider, model, external: { system: ext.system, ...(delegated ? { via: 'a2a' } : {}) } } });
  }
  logger.info({ msg: errorMessage ? 'turn.ended_degraded' : 'turn.completed', turnId, agent, session, external: ext.system, via: delegated ? 'a2a' : 'acp', ms: Date.now() - start, finalTextLen: finalText.length, ...(errorMessage ? { err: errorMessage } : {}) });
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

/** The task as sent: one line first naming who asks and the team, so the
 *  other side knows who it works for (external.a2a.introduce). */
async function introduced(text: string, args: RunChatTurnArgs, enabled: boolean): Promise<string> {
  if (!enabled) return text;
  const o = args.origin;
  const asker = args.fromAgent ?? (o?.kind === 'agent' ? o.from.agent : o?.kind === 'subagent' ? o.parent?.agent : undefined);
  if (!asker) return text;
  let who = asker;
  let principal: string | undefined;
  try {
    const team = await getResolvedTeam();
    const title = team?.agents[asker]?.title ?? team?.unlisted.find((u) => u.name === asker)?.title;
    if (title) who = `${asker} (${title})`;
    principal = team?.principal.name;
  } catch {
    /* no team: the name alone */
  }
  const role = o?.kind === 'subagent' ? 'a sub-task' : 'a task';
  return `[${role} from ${who}, an agent of ${principal ? `${principal}'s` : 'a'} somora team, sent over A2A]\n\n${text}`;
}

function describeToolCall(tc: RequestPermissionRequest['toolCall']): string {
  const title = typeof tc.title === 'string' ? tc.title : '';
  const raw = tc.rawInput as { command?: unknown } | undefined;
  const cmd = raw && typeof raw.command === 'string' ? raw.command : '';
  return (title || cmd).slice(0, 300);
}
