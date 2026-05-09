// runChatTurn — single chokepoint for "run one chat turn through the
// somora pipeline". Used by the live chat/send HTTP handler (which
// publishes events to SSE subscribers as they happen) and by
// spawn_subagent (which omits SSE since sub-flows are silent and
// just collects the final result).
//
// Pipeline stages:
//   1. resolve persona, session, model
//   2. append user_message to JSONL (with optional from_agent)
//   3. cancel any in-flight auto-dream + reset idle timer
//   4. compute self-pointer + system prompt
//   5. memory auto-inject (best-effort)
//   6. build tool-invoker bound to the per-turn ToolContext
//   7. run engine via runTurnWithFallback
//   8. for each event: persist (skip assistant_delta), invoke
//      optional publishSse callback, accumulate final text + usage
//   9. return the collected result
//
// publishSse is optional. When omitted, the turn runs silently; the
// agent's auto-dream worker still resets, JSONL still grows, memory
// inject still happens. This is the hot path for spawn_subagent.

import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { appendEvent, getHistory } from '../storage/sessions.ts';
import { resolveCompactionConfig } from '../compaction/index.ts';
import { getFreshConfig } from '../config/loader.ts';
import {
  type Config,
  listAllModels,
  resolveAnyRef,
  type ThinkingLevel,
} from '../config/types.ts';
import { engineRegistry } from '../engine/registry.ts';
import { runTurnWithFallback } from './run-turn-fallback.ts';
import { buildReviewLoopBlock, refreshLoopActivity } from '../dream/loop-state.ts';
import { injectMemoryContext } from '../memory/inject.ts';
import { getMemoryManager } from '../memory/registry.ts';
import { logger } from './logger.ts';
import { loadPersona, type Persona } from '../persona/loader.ts';
import { loadAvailableSkills } from '../skills/load.ts';
import { buildSkillsRegistry } from '../skills/registry.ts';
import { createTurnSerializer } from './sse-serializer.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { buildSelfPointer } from './workspace.ts';
import { SOMORA_HOME_DIR } from './logger.ts';

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high']);

function resolveEffectiveModel(
  config: Config,
  persona: Persona,
  sessionMeta: Record<string, unknown>,
) {
  const override = sessionMeta.modelOverride;
  const ref = typeof override === 'string' && override.length > 0 ? override : persona.model;
  if (!ref) return null;
  return resolveAnyRef(config, ref);
}

function resolveEffectiveThinking(
  persona: Persona,
  sessionMeta: Record<string, unknown>,
): ThinkingLevel | undefined {
  const override = sessionMeta.thinkingOverride;
  if (typeof override === 'string' && VALID_THINKING_LEVELS.has(override as ThinkingLevel)) {
    return override as ThinkingLevel;
  }
  return persona.thinking;
}

export interface RunChatTurnArgs {
  agent: string;
  session: string;
  /** The new user-message text (the model's input for this turn). */
  text: string;
  /** A2A: when set, this turn was authored by another agent, not by the
   *  human user. Persists in user_message.from_agent. */
  fromAgent?: string;
  /** A2A correlation UUID. Persisted on user_message.agent_ask_call_id;
   *  surfaced in the SSE user_message event so a human watching the
   *  session sees the inbound message appear in real time. */
  agentAskCallId?: string;
  /** Sub-agent nesting depth (0 = top-level user turn). */
  subagentDepth?: number;
  /** Optional override of the per-session model — caller passes the alias
   *  or "provider/id". Bypasses persona/session-meta resolution. */
  modelOverride?: string;
  /** Optional per-call override of the agent-loop tunables. Used by
   *  spawn_subagent to give orchestrator subs a higher maxRounds budget
   *  than the global default. Falls back to deps.config.agentLoop. */
  agentLoopOverride?: {
    maxRounds?: number;
    toolCallTimeoutMs?: number;
  };
  /** Optional SSE publisher. When provided, the turn streams agent-start,
   *  memory, tool, chat-delta/final, and agent-end events as they happen
   *  (live chat/send case). When omitted, no events are published — the
   *  spawn_subagent / silent-runner case. */
  publishSse?: (event: SseEvent) => Promise<void>;
  /** Optional abort signal. When the user presses ESC mid-turn the
   *  TUI hits /chat/abort which triggers this signal; the engine
   *  adapter (claude-cli/codex-cli/openai-compatible) honors it and
   *  cuts the in-flight LLM call cleanly. spawn_subagent flows
   *  don't pass this — they propagate parent-cancellation through
   *  the depth chain via their own mechanism. */
  signal?: AbortSignal;
  /** Wiring deps. Server boot constructs these once and reuses. */
  deps: ChatTurnResolveDeps;
}

export async function runChatTurn(args: RunChatTurnArgs): Promise<ChatTurnResult> {
  const start = Date.now();
  const {
    agent,
    session,
    text,
    fromAgent,
    agentAskCallId,
    subagentDepth = 0,
    modelOverride,
    agentLoopOverride,
    publishSse,
    signal,
    deps,
  } = args;

  const persona = await loadPersona(agent);
  if (!persona) {
    throw new Error(`agent '${agent}' nicht gefunden`);
  }

  const sessionMeta = await deps.sessionMetaStore.get(agent, session);
  const effectiveMetaForResolve = modelOverride
    ? { ...sessionMeta, modelOverride }
    : sessionMeta;
  const resolvedModel = resolveEffectiveModel(deps.config, persona, effectiveMetaForResolve);
  if (!resolvedModel) {
    throw new Error(
      `model für agent '${agent}' lässt sich nicht aus config.yaml auflösen — Format: provider/modelId oder alias`,
    );
  }
  const engine = engineRegistry[resolvedModel.provider.engine];
  if (!engine) {
    throw new Error(`keine engine '${resolvedModel.provider.engine}' registriert`);
  }

  // Compute the per-turn memory recall block FIRST so we can persist
  // it on the user_message event. Storing the recall block alongside
  // the user-typed text is what lets stateless openai-compatible
  // backends benefit from prefix-cache: history reconstruction at
  // turn N+1 produces the SAME byte sequence we sent at turn N (incl.
  // memory block), so the cache match holds across the entire prior
  // conversation. Without persistence, every turn would reconstruct
  // past user_messages without their memory blocks → byte-mismatch
  // → cache invalidates at the latest user-message position every
  // turn. Engines with stateful resumed sessions (claude-cli,
  // codex-cli) ignore this field — they inline the block once into
  // the outgoing message and the provider remembers everything.
  const historyBeforeTurn = await getHistory(agent, session);
  let ephemeralContext: string | undefined;
  let memoryHits: Array<{ source: string; slug: string; score: number }> = [];
  let memoryInjectedCount = 0;
  try {
    const mgr = await getMemoryManager(agent, {
      config: deps.config.memory,
      wiki: deps.config.wiki,
      obsidian: deps.config.obsidian,
    });
    const inject = await injectMemoryContext({
      mgr,
      history: historyBeforeTurn,
      userMessage: text,
      cfg: deps.config.memory.autoInject,
      ...(deps.config.wiki.enabled
        ? {
            wikiOverview: {
              maxChars: deps.config.wiki.search.overviewMaxChars,
              topNSlugs: deps.config.wiki.search.overviewTopNSlugs,
            },
          }
        : {}),
    });
    ephemeralContext = inject.ephemeralContext;
    memoryInjectedCount = inject.injectedCount;
    memoryHits = inject.hits;
    if (inject.injectedCount > 0) {
      logger.info({
        msg: 'memory.injected',
        agent,
        session,
        count: inject.injectedCount,
        slugs: inject.hits.map((h) => `${h.source}/${h.slug}`),
        topScore: inject.hits[0]?.score,
      });
    }
  } catch (err) {
    logger.warn({ msg: 'memory.inject_failed', agent, err: (err as Error).message });
  }

  // Loop-holder gets the active Lucid review block prepended to the
  // ephemeral context. Refreshed on every turn so the user can see
  // that the agent stays on topic until dream_review({action:'end'}).
  try {
    const reviewBlock = await buildReviewLoopBlock(agent);
    if (reviewBlock) {
      ephemeralContext = ephemeralContext
        ? `${reviewBlock}\n\n${ephemeralContext}`
        : reviewBlock;
      refreshLoopActivity(agent);
      logger.debug({ msg: 'dream.loop.injected', agent, session });
    }
  } catch (err) {
    logger.warn({ msg: 'dream.loop.inject_failed', agent, err: (err as Error).message });
  }

  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: engine.name,
    text,
    ...(fromAgent ? { from_agent: fromAgent } : {}),
    ...(agentAskCallId ? { agent_ask_call_id: agentAskCallId } : {}),
    ...(ephemeralContext ? { ephemeral: ephemeralContext } : {}),
  });

  // Live broadcast for A2A inbound messages: a human watching the
  // target's session sees the inbound turn appear in real time. Fires
  // only when fromAgent is set; self-typed turns are echoed by the TUI
  // locally and don't need the wire round-trip.
  if (publishSse && fromAgent) {
    await publishSse({
      event: 'user_message',
      data: {
        text,
        from_agent: fromAgent,
        ...(agentAskCallId ? { agent_ask_call_id: agentAskCallId } : {}),
      },
    });
  }

  // Reset the agent's auto-dream timer — sub-flows count as activity.
  deps.onActivity(agent);

  const modelSupportsReasoning = resolvedModel.model.capabilities.includes('reasoning');
  const effectiveThinking = resolveEffectiveThinking(persona, sessionMeta);
  if (publishSse) {
    const startThinkingPayload = effectiveThinking
      ? { level: effectiveThinking, active: modelSupportsReasoning }
      : undefined;
    await publishSse({
      event: 'agent',
      data: {
        phase: 'start',
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        ...(startThinkingPayload ? { thinking: startThinkingPayload } : {}),
      },
    });
  }

  // Surface the memory inject to SSE subscribers AFTER the agent_start
  // event so the chat-stream order stays sensible (agent starting →
  // what memory it pulled → tool calls → final answer).
  if (publishSse && memoryInjectedCount >= 0) {
    const refs = memoryHits.map((h) => `${h.source}/${h.slug}`);
    const topScore = memoryHits[0]?.score;
    await publishSse({
      event: 'memory',
      data: {
        count: memoryInjectedCount,
        ...(topScore !== undefined ? { topScore } : {}),
        refs,
        fullText: ephemeralContext ?? '',
      },
    });
  }

  let lastUsage:
    | {
        tokens_in: number;
        tokens_out: number;
        tokens_in_cached?: number;
        tokens_out_reasoning?: number;
      }
    | undefined;
  let finalText = '';
  let errorMessage: string | undefined;

  try {
    // Re-read history NOW (after we just appended the user_message
    // with its ephemeral block) so the engine sees the current turn
    // as the last entry — engines that reconstruct from history
    // (openai-compatible) get correct turn-order, and the persistent
    // ephemeral on the just-appended event flows naturally through
    // buildMessages without a separate inject step.
    const history = await getHistory(agent, session);

    const toolCtx = {
      agent,
      session,
      subagentDepth,
      getMemoryManager: () =>
        getMemoryManager(agent, {
          config: deps.config.memory,
          wiki: deps.config.wiki,
          obsidian: deps.config.obsidian,
        }),
      config: deps.config,
      // Surface the resolved model so capability-gated tools (file_read
      // polymorph) can check `image`/`pdf` capability before deciding
      // whether to return content blocks. Stays consistent across the
      // whole turn — even tool calls happening late in the loop see
      // the same active model.
      activeModel: resolvedModel,
    };
    const availableTools = await deps.tools.listAvailable(toolCtx);
    const toolInvoker = {
      list: () => availableTools,
      invoke: (name: string, input: unknown) => deps.tools.invoke(name, input, toolCtx),
    };

    // Build the self-pointer from FRESH config so newly-added resources
    // appear in the agent's "Configured remote resources: …" line on the
    // next turn instead of waiting for a server restart. Pairs with the
    // bug-4 hot-reload pattern (resource_list / resource_test already
    // use getFreshConfig). selfPointer otherwise stays stable across
    // turns within the same session — its content is derived from
    // config.resources + persona.resourceDeny + paths, none of which
    // change mid-turn — so the prefix-cache impact is nil.
    const freshConfig = await getFreshConfig();
    const selfPointer = buildSelfPointer(persona, freshConfig, SOMORA_HOME_DIR);
    const subContextNote =
      subagentDepth > 0
        ? `\n\nNote: this is a SUBAGENT turn (depth=${subagentDepth}). You were spawned by another agent to do a focused task; finish, return your result, and stop.`
        : '';
    // Skills registry — loaded fresh each turn so a SKILL.md edit takes
    // effect on the next turn without a server restart, same convention
    // as the persona reload above. Sits in the cached prefix portion of
    // the prompt: skills change rarely (rarer than memory which is
    // ephemeral and goes elsewhere), so they're ideal for prefix-cache.
    // Empty registry = empty section, no separator added.
    const allSkills = await loadAvailableSkills(freshConfig);
    const skillsRegistry = buildSkillsRegistry(allSkills, persona.skillsAllowList, freshConfig);
    const skillsBlock = skillsRegistry.text ? `\n\n---\n\n${skillsRegistry.text}` : '';
    const systemPromptForTurn = `${selfPointer}${subContextNote}\n\n---\n\n${persona.systemPrompt}${skillsBlock}`;

    const stream = runTurnWithFallback({
      primary: resolvedModel,
      fallbackRef: persona.fallback,
      config: deps.config,
      baseInput: {
        agent,
        session,
        systemPrompt: systemPromptForTurn,
        ephemeralContext,
        userMessage: text,
        ...(fromAgent ? { fromAgent } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        history,
        metaStore: deps.sessionMetaStore,
        availableModels: listAllModels(deps.config),
        compactionConfig: resolveCompactionConfig(deps.config),
        tools: toolInvoker,
        agentLoopConfig: agentLoopOverride
          ? { ...deps.config.agentLoop, ...agentLoopOverride }
          : deps.config.agentLoop,
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        ...(signal ? { signal } : {}),
      },
    });

    const serialize = publishSse ? createTurnSerializer() : null;
    for await (const ev of stream) {
      if (ev.kind !== 'assistant_delta') {
        await appendEvent(agent, session, ev);
      }
      if (ev.kind === 'turn_end' && ev.usage) lastUsage = ev.usage;
      if (ev.kind === 'assistant_message') {
        finalText = ev.text;
      } else if (ev.kind === 'assistant_delta' && !finalText) {
        // Fallback for engines that don't emit a final assistant_message
        finalText = ev.text;
      }
      if (serialize && publishSse) {
        const sse = serialize(ev);
        if (sse) await publishSse(sse);
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    logger.error({ msg: 'turn.fail', agent, session, err: errorMessage });
    if (publishSse) {
      await publishSse({
        event: 'status',
        data: { msg: `turn failed: ${errorMessage}` },
      });
    }
  }

  if (publishSse) {
    const thinkingPayload = effectiveThinking
      ? { level: effectiveThinking, active: modelSupportsReasoning }
      : undefined;
    await publishSse({
      event: 'agent',
      data: {
        phase: 'end',
        ...(lastUsage ? { usage: lastUsage } : {}),
        contextWindow: resolvedModel.model.contextWindow,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
      },
    });
  }

  return {
    finalText,
    usage: lastUsage,
    contextWindow: resolvedModel.model.contextWindow,
    provider: resolvedModel.providerName,
    model: resolvedModel.modelId,
    thinkingActive: modelSupportsReasoning && Boolean(effectiveThinking),
    thinkingLevel: effectiveThinking,
    ms: Date.now() - start,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

export type { ChatTurnResult } from './run-turn-types.ts';
