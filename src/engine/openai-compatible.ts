// openai-compatible engine: speaks /v1/chat/completions against any provider
// configured with baseUrl + apiKey. Stateless — we feed full message history
// each turn (no thread management on the server side, by design).

import OpenAI from 'openai';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { AgentEngine, TurnInput } from './types.ts';

const ENGINE = 'openai-compatible';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function buildMessages(
  systemPrompt: string,
  history: NormalizedEvent[],
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  let pendingRole: 'user' | 'assistant' | null = null;
  let pendingText = '';

  const flush = () => {
    if (pendingRole && pendingText) {
      messages.push({ role: pendingRole, content: pendingText });
    }
    pendingRole = null;
    pendingText = '';
  };

  for (const ev of history) {
    if (ev.kind === 'user_message') {
      if (pendingRole !== 'user') flush();
      pendingRole = 'user';
      pendingText = pendingText ? `${pendingText}\n\n${ev.text}` : ev.text;
    } else if (ev.kind === 'assistant_message') {
      if (pendingRole !== 'assistant') flush();
      pendingRole = 'assistant';
      pendingText = pendingText ? `${pendingText}\n\n${ev.text}` : ev.text;
    }
    // tool_call / tool_result / deltas / turn_start / turn_end → ignore for chat.completions
  }
  flush();
  return messages;
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
  }
  // Rough heuristic: ~4 chars per token. Good enough for soft warnings.
  return Math.ceil(chars / 4);
}

export const openAiCompatibleEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const { agent, session, systemPrompt, history, metaStore, resolvedModel } = input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(`openai-compatible engine called with non-matching provider engine: ${resolvedModel.provider.engine}`);
    }

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    const messages = buildMessages(systemPrompt, history);
    const estTokens = estimateTokens(messages);
    const ctxRatio = estTokens / resolvedModel.model.contextWindow;
    if (ctxRatio > 0.7) {
      logger.warn({
        msg: 'engine.context_warn',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        agent,
        session,
        estimatedTokens: estTokens,
        contextWindow: resolvedModel.model.contextWindow,
        ratio: Math.round(ctxRatio * 100) / 100,
        hint: 'history nähert sich dem context-window-Limit. Memory-Schicht (Phase 2) ist die Lösung; vorerst /new bei Hans empfehlen.',
      });
    }

    const client = new OpenAI({
      baseURL: resolvedModel.provider.baseUrl,
      apiKey: resolvedModel.provider.apiKey,
    });

    let cumulative = '';
    let usage: { tokens_in: number; tokens_out: number } | undefined;

    try {
      logger.info({
        msg: 'engine.init',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        baseUrl: resolvedModel.provider.baseUrl,
        estimatedTokens: estTokens,
      });

      const stream = await client.chat.completions.create({
        model: resolvedModel.modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(resolvedModel.model.maxTokens ? { max_tokens: resolvedModel.model.maxTokens } : {}),
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          cumulative += delta;
          yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: cumulative };
        }
        if (chunk.usage) {
          usage = {
            tokens_in: chunk.usage.prompt_tokens ?? 0,
            tokens_out: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      if (cumulative) {
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: cumulative };
      }

      logger.info({
        msg: 'engine.turn',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        agent,
        session,
        tokens_in: usage?.tokens_in,
        tokens_out: usage?.tokens_out,
      });

      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...(usage ? { usage } : {}) };

      // Tag the session with the engine that owns it now (for future routing logic)
      const meta = await metaStore.get(agent, session);
      if (meta.engine !== ENGINE) {
        await metaStore.set(agent, session, { ...meta, engine: ENGINE });
      }
    } catch (err) {
      logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
      yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
    }
  },
};
