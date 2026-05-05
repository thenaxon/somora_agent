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
import { withFromAgentHeader } from './a2a.ts';
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
      // A2A attribution: prepend a header when this user-message was
      // written by another agent so the model sees the provenance
      // even after replay across engines.
      const text = withFromAgentHeader(ev.text, ev.from_agent);
      pendingText = pendingText ? `${pendingText}\n\n${text}` : text;
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

/**
 * Place the per-turn ephemeralContext (memory recall block, already
 * wrapped in `<memory-context>...</memory-context>`) at the end of the
 * messages array so the persistent system prompt above stays stable
 * across turns. Two placement strategies:
 *
 *   late         → insert as a second `role:'system'` message right
 *                  before the latest `role:'user'` message. Models
 *                  treat memory as system-level guidance.
 *   inline-user  → prepend to the latest user message's content,
 *                  separated by a blank line. Use for backends that
 *                  mishandle multi-system-message conversations.
 *
 * If no `role:'user'` is found in messages (shouldn't happen — the
 * runtime always appends the new user_message before the engine
 * runs), we fall back to appending as a system message at the very
 * end so the recall isn't silently dropped.
 */
function injectEphemeralLate(args: {
  messages: ChatMessage[];
  ephemeralContext: string;
  mode: 'late' | 'inline-user';
}): void {
  const { messages, ephemeralContext, mode } = args;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    messages.push({ role: 'system', content: ephemeralContext });
    return;
  }
  if (mode === 'inline-user') {
    const u = messages[lastUserIdx]!;
    if (typeof u.content === 'string') {
      u.content = `${ephemeralContext}\n\n${u.content}`;
    }
    // Non-string user content (multi-modal arrays) is rare in our
    // current pipeline; fall back to a system message just before
    // user when we can't safely splice into the content.
    else {
      messages.splice(lastUserIdx, 0, { role: 'system', content: ephemeralContext });
    }
    return;
  }
  // mode === 'late': insert as system message right before the user
  messages.splice(lastUserIdx, 0, { role: 'system', content: ephemeralContext });
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
      thinking,
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

    // Memory inject placement controls prefix-cache hit-rate. Old default
    // ('system' mode) concat'd ephemeralContext onto the system prompt,
    // which made the entire system block change every turn → cache for
    // anything downstream invalidates per turn. The new default ('late')
    // injects memory as a SECOND system message right before the latest
    // user message, leaving the persistent system block stable and
    // cacheable across turns.
    //
    // 'inline-user' is the fallback for backends that mishandle multi-
    // system-message conversations: same cache benefit, memory just
    // shows up inside the user turn instead of as system instructions.
    //
    // 'system' is the legacy mode, opt-in via config when a particular
    // backend is hostile to the late-system placement.
    const memoryInjectMode =
      (resolvedModel.provider as { memoryInjectMode?: 'late' | 'inline-user' | 'system' })
        .memoryInjectMode ?? 'late';
    const useLegacySystemConcat = memoryInjectMode === 'system';
    const effectiveSystemPrompt =
      useLegacySystemConcat && ephemeralContext
        ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
        : systemPrompt;
    const messages = buildMessages(effectiveSystemPrompt, history, compactions);
    if (!useLegacySystemConcat && ephemeralContext) {
      injectEphemeralLate({ messages, ephemeralContext, mode: memoryInjectMode });
    }
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
    const toolList = tools ? tools.list() : [];
    const openAiTools: ChatTool[] | undefined = tools ? toOpenAiTools(toolList) : undefined;
    const toolByName = new Map(toolList.map((t) => [t.name, t]));
    const loopMessages = [...messages]; // mutable copy; tool rounds append
    const maxRounds = input.agentLoopConfig?.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const globalToolTimeoutMs =
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

      // Cross-engine thinking knob → OpenAI's `reasoning_effort` body param
       // (gpt-5/o1-style). Only applied when the model declares 'reasoning'
      // capability; for opaque local endpoints (Gemma etc.) we omit it
      // entirely so the request stays clean and the user sees the dormant
      // state in the header.
      const reasoningEffort =
        thinking &&
        thinking !== 'off' &&
        resolvedModel.model.capabilities.includes('reasoning')
          ? thinking
          : null;

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
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
          // Resolve the per-call timeout. Tools that declare themselves
          // long-running (subagent_result with wait_until_done, agent_ask,
          // exec, etc.) override the global cap via timeoutFromInput
          // (dynamic, per-call) or defaultTimeoutMs (static). maxTimeoutMs
          // hard-caps both so a malformed model-supplied timeout_ms can't
          // pin a slot indefinitely. Pattern adapted from OpenClaw's
          // waitForAgentRun — engine itself has no fixed cap, the caller
          // declares the budget.
          const toolDef = toolByName.get(call.function.name);
          const dynamicTimeout = toolDef?.timeoutFromInput?.(parsedArgs as never);
          const staticTimeout = toolDef?.defaultTimeoutMs;
          const hardCap = toolDef?.maxTimeoutMs;
          let toolTimeoutMs = dynamicTimeout ?? staticTimeout ?? globalToolTimeoutMs;
          if (hardCap !== undefined) toolTimeoutMs = Math.min(toolTimeoutMs, hardCap);
          // Race the tool invocation against the resolved timeout. On
          // timeout we feed an error back to the model — same shape as a
          // regular tool error, but with a hint so the model knows it can
          // retry with a higher timeout_ms instead of blind retry-storming.
          const result = await Promise.race([
            tools.invoke(call.function.name, parsedArgs),
            new Promise<{ ok: false; error: string }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    error:
                      `tool '${call.function.name}' timed out after ${toolTimeoutMs}ms` +
                      (dynamicTimeout !== undefined
                        ? ` — call again with a higher timeout_ms if more time is needed`
                        : ''),
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

      // Force-summary fallback: if the loop exited at maxRounds with
      // no accumulated assistant content (model spent all rounds on
      // tool calls), make one final no-tools call to extract a summary.
      // Without this, the caller gets `result: ""` silently and can't
      // tell the sub bailed out — Hans's bug report from 2026-05-03.
      if (!cumulative && round >= maxRounds) {
        logger.warn({
          msg: 'engine.force_summary_after_cap',
          engine: ENGINE,
          agent,
          session,
          rounds: round,
        });
        loopMessages.push({
          role: 'system',
          content:
            'You have reached the maximum number of tool-call rounds for this turn ' +
            `(${maxRounds}). Respond NOW without further tool calls — summarize what you ` +
            'have learned from the tool results so far, even partially. Do not call any tools.',
        } as ChatMessage);
        try {
          const summaryStream = await client.chat.completions.create({
            model: resolvedModel.modelId,
            messages: loopMessages,
            stream: true,
            stream_options: { include_usage: true },
            ...(resolvedModel.model.maxTokens
              ? { max_tokens: resolvedModel.model.maxTokens }
              : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            // No tools, no tool_choice — pure text response.
          });
          for await (const chunk of summaryStream) {
            const choice = chunk.choices[0];
            const delta = choice?.delta;
            if (delta?.content && typeof delta.content === 'string') {
              cumulative += delta.content;
              yield {
                kind: 'assistant_delta',
                ts: ts(),
                engine: ENGINE,
                text: cumulative,
              };
            }
            const usage = chunk.usage;
            if (usage) {
              const prevIn = totalUsage?.tokens_in ?? 0;
              const prevOut = totalUsage?.tokens_out ?? 0;
              totalUsage = {
                tokens_in: prevIn + (usage.prompt_tokens ?? 0),
                tokens_out: prevOut + (usage.completion_tokens ?? 0),
              };
            }
          }
        } catch (err) {
          logger.error({
            msg: 'engine.force_summary_failed',
            engine: ENGINE,
            err: (err as Error).message,
          });
          // Fallback synthetic message so the caller at least knows
          // what happened, even if the summary call itself failed.
          cumulative =
            `[somora] Sub-agent reached the agent-loop cap of ${maxRounds} tool-call rounds ` +
            'without producing a final answer, and the force-summary fallback also failed: ' +
            `${(err as Error).message}. Inspect the sub-session JSONL for the partial tool results.`;
        }
      }

      if (cumulative) {
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: cumulative };
      } else if (round >= maxRounds) {
        // Loop ended at the cap and the force-summary path didn't
        // populate cumulative either — synthesize a marker so the
        // caller doesn't get `result: ""` silently.
        cumulative =
          `[somora] Sub-agent reached the agent-loop cap of ${maxRounds} tool-call rounds ` +
          'and produced no final message. Increase agentLoop.maxRounds in config.yaml or ' +
          'pass agentLoop.maxRounds in spawn_subagent input if more rounds are needed.';
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

      yield {
        kind: 'turn_end',
        ts: ts(),
        engine: ENGINE,
        turnId,
        ...(totalUsage
          ? {
              usage: {
                ...totalUsage,
                ...(tokensInCached !== undefined ? { tokens_in_cached: tokensInCached } : {}),
              },
            }
          : {}),
      };

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
