// openai-compatible engine: speaks /v1/chat/completions against any provider
// configured with baseUrl + apiKey. Stateless — we feed full message history
// each turn (no thread management on the server side, by design).
//
// Compaction (DECISIONS #21): before each turn we estimate the prompt
// size and, if it crosses the configured threshold, run a compaction
// pass via the same provider. The result is persisted to
// `meta.compactions[]` (non-destructive — JSONL stays untouched) and
// the next message-build uses the summary in place of compacted events.

import OpenAI from 'openai';
import {
  DEFAULT_COMPACTION_CONFIG,
  pickLatest,
  runCompaction,
  shouldCompact,
  type Compaction,
} from '../compaction/index.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { AgentEngine, TurnInput } from './types.ts';

const ENGINE = 'openai-compatible';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface OpenAiCompatibleMeta {
  engine?: string;
  compactions?: Compaction[];
}

function buildMessages(
  systemPrompt: string,
  history: NormalizedEvent[],
  compactions: Compaction[] | undefined,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  // Prepend the latest compaction summary as a second system message.
  // Most OpenAI-compatible providers accept multiple system messages;
  // those that don't will collapse them on their side.
  const latest = pickLatest(compactions);
  if (latest) {
    messages.push({
      role: 'system',
      content: [
        '<conversation-summary>',
        'Eine vorherige Compaction hat den älteren Verlauf der',
        'Session zusammengefasst. Behandle den folgenden Block als',
        'verlässlichen Kontext für alle nicht weiter unten explizit',
        'wiederholten Fakten:',
        '',
        latest.summary,
        '</conversation-summary>',
      ].join('\n'),
    });
  }
  const sinceTs = latest?.throughTs ?? 0;

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
    if (ev.ts <= sinceTs) continue; // skip events covered by compaction
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
    const { agent, session, systemPrompt, history, metaStore, resolvedModel, availableModels } =
      input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(`openai-compatible engine called with non-matching provider engine: ${resolvedModel.provider.engine}`);
    }

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let meta = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
    let compactions = meta.compactions;

    // Pre-turn compaction check. Compaction config is currently fixed
    // to the defaults; per-provider override can be added later.
    const compactionConfig = DEFAULT_COMPACTION_CONFIG;
    const decision = shouldCompact({
      systemPrompt,
      history,
      compactions,
      contextWindow: resolvedModel.model.contextWindow,
      config: compactionConfig,
    });
    if (decision.shouldCompact) {
      logger.info({
        msg: 'engine.compaction_trigger',
        engine: ENGINE,
        agent,
        session,
        estimatedTokens: decision.estimatedTokens,
        triggerTokens: decision.triggerTokens,
        ratio: Math.round(decision.ratio * 100) / 100,
        existingCompactions: compactions?.length ?? 0,
      });
      try {
        const newCompaction = await runCompaction({
          systemPrompt,
          history,
          resolvedModel,
          availableModels,
          compactions,
          config: compactionConfig,
        });
        if (newCompaction) {
          compactions = [...(compactions ?? []), newCompaction];
          await metaStore.set(agent, session, {
            ...meta,
            compactions,
          });
          meta = { ...meta, compactions };
          logger.info({
            msg: 'engine.compaction_done',
            engine: ENGINE,
            agent,
            session,
            throughTs: newCompaction.throughTs,
            tokensBefore: newCompaction.tokensBefore,
            tokensAfter: newCompaction.tokensAfter,
            summaryChars: newCompaction.summary.length,
          });
        } else {
          logger.info({
            msg: 'engine.compaction_skip',
            engine: ENGINE,
            agent,
            session,
            reason: 'extractCompactionRange returned null (cushion covers everything or empty summary)',
          });
        }
      } catch (err) {
        // Don't kill the turn if compaction itself fails — degrade gracefully.
        logger.warn({
          msg: 'engine.compaction_fail',
          engine: ENGINE,
          agent,
          session,
          err: String(err),
        });
      }
    }

    const messages = buildMessages(systemPrompt, history, compactions);
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
        hint: 'history nähert sich dem context-window-Limit auch nach Compaction. Mehr Polster via niedrigeren triggerRatio.',
      });
    }

    const client = new OpenAI({
      baseURL: resolvedModel.provider.baseUrl,
      apiKey: resolvedModel.provider.apiKey,
    });

    let cumulative = '';
    let usage: { tokens_in: number; tokens_out: number } | undefined;
    let tokensInCached: number | undefined;

    try {
      logger.info({
        msg: 'engine.init',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        baseUrl: resolvedModel.provider.baseUrl,
        estimatedTokens: estTokens,
        compactionsApplied: compactions?.length ?? 0,
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
          // OpenAI-compatible providers return `prompt_tokens` as TOTAL
          // input size (cached + uncached). Some expose a cached subset
          // via `prompt_tokens_details.cached_tokens` — diagnostics only.
          tokensInCached = (
            chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }
          ).prompt_tokens_details?.cached_tokens;
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
        tokens_in_cached: tokensInCached,
        tokens_out: usage?.tokens_out,
      });

      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...(usage ? { usage } : {}) };

      // Tag the session with the engine that owns it now (for future routing logic).
      // Re-read in case compaction wrote in-between to avoid clobbering.
      const fresh = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
      if (fresh.engine !== ENGINE) {
        await metaStore.set(agent, session, { ...fresh, engine: ENGINE });
      }
    } catch (err) {
      logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
      yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
    }
  },
};
