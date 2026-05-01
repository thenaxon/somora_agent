// openai-compatible engine: speaks /v1/chat/completions against any provider
// configured with baseUrl + apiKey. Stateless — we feed full message history
// each turn (no thread management on the server side, by design).
//
// Compaction (DECISIONS #21): before each turn we estimate the prompt
// size and, if it crosses the configured threshold, run a compaction
// pass via the same provider. The result is persisted to
// `meta.compactions[]` (non-destructive — JSONL stays untouched) and
// the next message-build uses the summary in place of compacted events.
//
// Agent-loop (Phase 2-Stufe-C): when TurnInput.tools is present, we run
// chat.completions in a loop. The model can request tool calls; we
// execute them via the registry and feed results back. Loop exits when
// the model returns a final response without tool_calls, or when we hit
// MAX_TOOL_ROUNDS (defensive cap, prevents runaway models). claude-cli
// and codex-cli ignore TurnInput.tools — they configure the somora-memory
// MCP server out-of-process and let their CLI handle dispatch.

import OpenAI from 'openai';
import {
  pickLatest,
  runCompaction,
  shouldCompact,
  type Compaction,
} from '../compaction/index.ts';
import { logger } from '../server/logger.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { AgentEngine, TurnInput } from './types.ts';

const ENGINE = 'openai-compatible';

// Hard fallbacks if the server forgot to pass an agent-loop config.
// Should never fire in practice — `config.agentLoop` is non-optional in
// the Zod schema and defaults itself.
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type StreamingToolCall = {
  id: string;
  name: string;
  argsJson: string; // accumulated as fragments arrive
};

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

/**
 * Convert our ToolDefinition[] to OpenAI's `tools` parameter shape.
 * Each tool's `jsonSchema` is already a complete JSON Schema object
 * matching what `parameters:` expects.
 */
function toOpenAiTools(defs: ToolDefinition[]): ChatTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.jsonSchema as Record<string, unknown>,
    },
  }));
}

export const openAiCompatibleEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const {
      agent,
      session,
      systemPrompt,
      ephemeralContext,
      history,
      metaStore,
      resolvedModel,
      availableModels,
    } = input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(`openai-compatible engine called with non-matching provider engine: ${resolvedModel.provider.engine}`);
    }

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let meta = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
    let compactions = meta.compactions;

    // Compaction tunables come from the server-resolved config (env > yaml > defaults).
    const compactionConfig = input.compactionConfig;
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

    // Concat ephemeral block into the system message so OpenAI-compatible
    // backends without multi-system-message support still see it. Backends
    // that DO accept multiple system messages would also work — we just
    // pick the simpler form.
    const effectiveSystemPrompt = ephemeralContext
      ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
      : systemPrompt;
    const messages = buildMessages(effectiveSystemPrompt, history, compactions);
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

    // Cumulative content across ALL tool-rounds. The model may speak in
    // round 1 ("Let me check..."), call tools, then continue in round 2
    // ("Based on what I found, …"). We concat with a blank line between
    // round-segments so the streamed view to the user keeps growing
    // monotonically — matches how claude-cli's SDK presents
    // tool-using turns to us (one final assistant_message at the end).
    let cumulative = '';
    let totalUsage: { tokens_in: number; tokens_out: number } | undefined;
    let tokensInCached: number | undefined;

    const tools = input.tools;
    const openAiTools: ChatTool[] | undefined = tools ? toOpenAiTools(tools.list()) : undefined;
    const loopMessages = [...messages]; // mutable copy; tool rounds append
    const maxRounds = input.agentLoopConfig?.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const toolTimeoutMs =
      input.agentLoopConfig?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;

    try {
      logger.info({
        msg: 'engine.init',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        baseUrl: resolvedModel.provider.baseUrl,
        estimatedTokens: estTokens,
        compactionsApplied: compactions?.length ?? 0,
        toolsAdvertised: openAiTools?.length ?? 0,
      });

      let round = 0;
      while (round < maxRounds) {
        round++;
        const stream = await client.chat.completions.create({
          model: resolvedModel.modelId,
          messages: loopMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...(openAiTools ? { tools: openAiTools, tool_choice: 'auto' } : {}),
          ...(resolvedModel.model.maxTokens ? { max_tokens: resolvedModel.model.maxTokens } : {}),
        });

        // Per-round accumulators
        let roundContent = '';
        const roundToolCalls = new Map<number, StreamingToolCall>();
        let finishReason: string | null = null;

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta;
          if (delta?.content && typeof delta.content === 'string') {
            roundContent += delta.content;
            // Stream the running cumulative (existing rounds + this round so far).
            const runningCumulative = cumulative
              ? `${cumulative}\n\n${roundContent}`
              : roundContent;
            yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: runningCumulative };
          }
          if (delta?.tool_calls) {
            // tool_calls stream as fragments indexed by `index`. Accumulate
            // name and arguments-JSON across chunks.
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const slot =
                roundToolCalls.get(idx) ?? { id: '', name: '', argsJson: '' };
              if (tc.id && !slot.id) slot.id = tc.id;
              if (tc.function?.name && !slot.name) slot.name = tc.function.name;
              if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
              roundToolCalls.set(idx, slot);
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            tokensInCached = (
              chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }
            ).prompt_tokens_details?.cached_tokens;
            const u = {
              tokens_in: chunk.usage.prompt_tokens ?? 0,
              tokens_out: chunk.usage.completion_tokens ?? 0,
            };
            // Accumulate across rounds for the final turn_end usage.
            totalUsage = totalUsage
              ? {
                  tokens_in: totalUsage.tokens_in + u.tokens_in,
                  tokens_out: totalUsage.tokens_out + u.tokens_out,
                }
              : u;
          }
        }

        // Merge the round's content into the cumulative (separator only when
        // there's previous content AND new content).
        if (roundContent) {
          cumulative = cumulative ? `${cumulative}\n\n${roundContent}` : roundContent;
        }

        if (roundToolCalls.size === 0) {
          // No tools requested — model gave its final answer this round.
          break;
        }

        // Persist the assistant turn (with tool_calls) to the chat history.
        // The OpenAI API requires the tool_call message before the tool
        // results, so we add both before the next round.
        const toolCallsForApi = [...roundToolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => ({
            id: c.id || `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: { name: c.name, arguments: c.argsJson || '{}' },
          }));

        loopMessages.push({
          role: 'assistant',
          // OpenAI accepts content=null when only tool_calls are present.
          content: roundContent || null,
          tool_calls: toolCallsForApi,
        } as ChatMessage);

        // Run each tool call, emit normalized events, append a `tool` message
        // per result for the next round.
        if (!tools) {
          // Should never happen — if there are no tools advertised the model
          // shouldn't request them. Bail with a clear error.
          throw new Error('model requested tool_calls but no tool registry was passed to the engine');
        }
        for (const call of toolCallsForApi) {
          let parsedArgs: unknown = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch {
            // leave as raw string fallback so tool sees something
            parsedArgs = { _raw: call.function.arguments };
          }
          yield {
            kind: 'tool_call',
            ts: ts(),
            engine: ENGINE,
            callId: call.id,
            tool: call.function.name,
            input: parsedArgs,
          };
          // Race the tool invocation against a timeout. On timeout we feed
          // an error back to the model — same shape as a regular tool error.
          const result = await Promise.race([
            tools.invoke(call.function.name, parsedArgs),
            new Promise<{ ok: false; error: string }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    error: `tool '${call.function.name}' timed out after ${toolTimeoutMs}ms`,
                  }),
                toolTimeoutMs,
              ),
            ),
          ]);
          const outputText = result.ok
            ? JSON.stringify(result.data)
            : (result.error ?? 'tool failed');
          yield {
            kind: 'tool_result',
            ts: ts(),
            engine: ENGINE,
            callId: call.id,
            output: result.ok ? result.data : null,
            ...(result.ok ? {} : { error: result.error ?? 'tool failed' }),
          };
          loopMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: outputText,
          } as ChatMessage);
        }

        // Defensive: if we hit the round cap with tools still pending, log
        // and stop. The loop guard at the top will exit on the next check.
        if (round >= maxRounds) {
          logger.warn({
            msg: 'engine.tool_loop_cap',
            engine: ENGINE,
            agent,
            session,
            rounds: round,
            maxRounds,
            hint: 'model still wanted to call tools at agentLoop.maxRounds; stopping to prevent runaway. Increase via config.yaml agentLoop.maxRounds.',
          });
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
        tokens_in: totalUsage?.tokens_in,
        tokens_in_cached: tokensInCached,
        tokens_out: totalUsage?.tokens_out,
        toolRounds: round,
      });

      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...(totalUsage ? { usage: totalUsage } : {}) };

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
