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

import { randomUUID } from 'node:crypto';
import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { appendEvent, getHistory } from '../storage/sessions.ts';
import { healOrphanToolCalls } from './heal-session.ts';
import { readProject } from '../projects/store.ts';
import { renderProjectBlock } from '../projects/prompt-block.ts';
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
import type { ResolvedAttachment } from '../engine/types.ts';
import { resolveAttachmentByHash } from '../attachments/store.ts';
import {
  buildReviewLoopBlock,
  refreshLoopActivity,
  resetWikiCallCounter,
} from '../dream/loop-state.ts';
import { injectMemoryContext } from '../memory/inject.ts';
import { getMemoryManager } from '../memory/registry.ts';
import { logger } from './logger.ts';
import { loadPersona, type Persona } from '../persona/loader.ts';
import { loadAvailableSkills } from '../skills/load.ts';
import { buildSkillsRegistry } from '../skills/registry.ts';
import { createTurnSerializer } from './sse-serializer.ts';
import { sanitizeAssistantText } from './sanitize-assistant-text.ts';
import { synthesize } from '../tts/service.ts';
import { prepareForTts } from '../tts/prepare-for-tts.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { buildSelfPointer } from './workspace.ts';
import { SOMORA_HOME_DIR } from './logger.ts';

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high']);

/**
 * Build the project-block portion of the system prompt. Returns the
 * empty string when:
 *   - config.projects is missing or `enabled: false`
 *   - session has no `projectSlug` (nothing pinned)
 *   - the slug points at a missing file (warn-log + soft-degrade)
 *
 * Reads from disk every turn so a `project_update` lands in the next
 * turn's prompt without any cache-invalidation step. The pure-frontmatter
 * file format keeps this read cheap.
 */
async function buildProjectBlock(
  sessionMeta: Record<string, unknown>,
  config: Config,
): Promise<string> {
  if (!config.projects?.enabled) return '';
  const slug = sessionMeta.projectSlug;
  if (typeof slug !== 'string' || slug.length === 0) return '';
  try {
    const project = await readProject(slug);
    if (!project) {
      logger.warn({
        msg: 'project.focused_but_missing',
        slug,
        hint: 'session.meta points at a project file that no longer exists; project block will be empty',
      });
      return '';
    }
    return renderProjectBlock(project);
  } catch (err) {
    logger.warn({
      msg: 'project.load_failed',
      slug,
      err: (err as Error).message,
    });
    return '';
  }
}

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

// Resolve the idle-event watchdog timeout per engine. Defaults live in
// EngineWatchdogConfigSchema; this just bridges engine-name → field.
function pickIdleTimeoutForEngine(
  cfg: import('../config/types.ts').EngineWatchdogConfig,
  engine: import('../config/types.ts').EngineName,
): number {
  switch (engine) {
    case 'claude-cli':
      return cfg.claudeCliIdleMs;
    case 'codex-cli':
      return cfg.codexCliIdleMs;
    case 'openai-compatible':
      return cfg.openaiCompatibleIdleMs;
  }
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
  /** Stable id used to correlate all log lines produced for this turn —
   *  from /chat/send acceptance through engine init, first event, and
   *  completion. Auto-generated when omitted; callers (HTTP handlers)
   *  pass one if they logged it earlier so the trace stays connected. */
  turnId?: string;
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
  /** User-attached files for this turn (Phase Y.B). Refs persisted on
   *  the user_message event in JSONL; resolved to absolute paths +
   *  metadata before the engine runs. */
  attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
  /** Voice: how the user produced this turn. `voice` ⇒ STT-transcribed
   *  on web/mobile or via /voice/turn. `text` (or undefined) ⇒ typed.
   *  Persists on user_message.input.modality and gates auto-TTS. */
  inputModality?: 'text' | 'voice';
  /** Voice: free-form tag for the STT path used (provider name). */
  sttProvider?: string;
  /** Voice: did the client request a spoken reply for this turn? The
   *  auto-TTS hook fires only when (inputModality==='voice' AND
   *  autoPlayRequested===true). Default-off keeps text-only sessions
   *  silent. */
  autoPlayRequested?: boolean;
  /** Wiring deps. Server boot constructs these once and reuses. */
  deps: ChatTurnResolveDeps;
}

/**
 * Auto-TTS background task. Called fire-and-forget after a turn
 * completes whose user_message arrived via voice + autoPlayRequested.
 * Sanitizes the assistant text for speech, synthesizes audio (or
 * grabs from cache), appends an `assistant_audio` event to JSONL, and
 * broadcasts via SSE so live clients can render a Play-button and
 * auto-play if their toggle is on.
 */
async function generateAutoTts(args: {
  agent: string;
  session: string;
  turnId: string;
  text: string;
  engine: string;
  config: Config;
  publishSse?: (event: SseEvent) => Promise<void>;
  parentTurnId: string;
}): Promise<void> {
  const { agent, session, turnId, text, engine, config, publishSse, parentTurnId } = args;
  const ttsCfg = config.tts;
  if (!ttsCfg?.enabled) return;

  const prepared = prepareForTts(text);
  if (prepared.skipped) {
    logger.info({
      msg: 'turn.auto_tts_skipped',
      turnId: parentTurnId,
      agent,
      session,
      reason: prepared.reason,
    });
    return;
  }

  const start = Date.now();
  // Auto-TTS always serves opus when reencode is on — smallest
  // payload for mobile auto-play. Falls back to wav otherwise.
  const fmt: 'wav' | 'opus' = ttsCfg.reencode.enabled ? 'opus' : 'wav';
  const synth = await synthesize(
    {
      text: prepared.text,
      ...(ttsCfg.voice ? { voice: ttsCfg.voice } : {}),
      ...(ttsCfg.language ? { language: ttsCfg.language } : {}),
      format: fmt,
      agent,
    },
    config,
  );
  const url = `/tts/cache/${synth.cacheKey}.${synth.ext}`;
  logger.info({
    msg: 'turn.auto_tts_ready',
    turnId: parentTurnId,
    agent,
    session,
    cacheHit: synth.cacheHit,
    cacheKey: synth.cacheKey,
    bytes: synth.bytes.length,
    durationMs: synth.durationMs ?? null,
    ms: Date.now() - start,
  });

  const evt = {
    kind: 'assistant_audio' as const,
    ts: Date.now(),
    engine,
    turnId,
    audio: {
      url,
      mime: synth.mime,
      ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
      cacheKey: synth.cacheKey,
    },
  };
  await appendEvent(agent, session, evt);
  if (publishSse) {
    await publishSse({
      event: 'assistant_audio',
      data: {
        turnId,
        url,
        mime: synth.mime,
        ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
        cacheKey: synth.cacheKey,
      },
    });
  }
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
    attachments,
    inputModality,
    sttProvider,
    autoPlayRequested,
    deps,
  } = args;
  // Turn-lifecycle id — stable across every log line this turn produces,
  // so an overnight forensics pass can trace a hung turn from /chat/send
  // through memory inject + engine init + first event + completion.
  // Caller may pre-generate one (HTTP /chat/send does, so the trace
  // begins at request acceptance) — otherwise we mint here.
  const turnId = args.turnId ?? randomUUID();
  logger.info({
    msg: 'turn.started',
    turnId,
    agent,
    session,
    subagentDepth,
    fromAgent: fromAgent ?? null,
    textLen: text.length,
    attachmentCount: attachments?.length ?? 0,
  });

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

  // Self-heal: if the previous turn died mid-flight (engine subprocess
  // crash after tool_use but before tool_result), the JSONL tail will
  // have an orphan tool_call. Inject synthetic tool_result + turn_end
  // and clear the SDK session-id BEFORE we append the new user_message
  // so the engine sees a consistent history when it starts. The user
  // gets self-recovery just by sending another message; no /reset
  // needed. Reference: jarvis 2026-05-13 silent claude-cli crash.
  try {
    await healOrphanToolCalls({
      agent,
      session,
      history: historyBeforeTurn,
      metaStore: deps.sessionMetaStore,
      fallbackEngine: engine.name,
    });
  } catch (err) {
    logger.warn({
      msg: 'session.heal_failed',
      agent,
      session,
      err: (err as Error).message,
    });
  }

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
        turnId,
        agent,
        session,
        count: inject.injectedCount,
        slugs: inject.hits.map((h) => `${h.source}/${h.slug}`),
        topScore: inject.hits[0]?.score,
      });
    }
  } catch (err) {
    logger.warn({ msg: 'memory.inject_failed', turnId, agent, err: (err as Error).message });
  }

  // Loop-holder gets the active Lucid review block prepended to the
  // ephemeral context. Refreshed on every turn so the user can see
  // that the agent stays on topic until dream_review({action:'end'}).
  // Each new user turn also resets the per-turn wiki_* call counter
  // so the cap (MAX_WIKI_CALLS_PER_TURN) applies to *this* turn only.
  try {
    const reviewBlock = await buildReviewLoopBlock(agent);
    if (reviewBlock) {
      ephemeralContext = ephemeralContext
        ? `${reviewBlock}\n\n${ephemeralContext}`
        : reviewBlock;
      refreshLoopActivity(agent);
      resetWikiCallCounter();
      logger.debug({ msg: 'dream.loop.injected', agent, session });
    }
  } catch (err) {
    logger.warn({ msg: 'dream.loop.inject_failed', agent, err: (err as Error).message });
  }

  // Resolve attachment refs to absolute paths + metadata BEFORE the
  // user_message is persisted. If a hash isn't on disk we fail the
  // whole turn early (clean error to client) rather than persisting
  // a ref that points at nothing. Per-turn count + per-file caps
  // were enforced at upload time; here we just do a sanity stat.
  const resolvedAttachments: ResolvedAttachment[] = [];
  if (attachments && attachments.length > 0) {
    if (attachments.length > deps.config.attachments.maxPerTurn) {
      throw new Error(
        `${attachments.length} attachments exceed the per-turn cap of ${deps.config.attachments.maxPerTurn} (config.attachments.maxPerTurn)`,
      );
    }
    for (const a of attachments) {
      const r = await resolveAttachmentByHash({ hash: a.hash, expectedMime: a.mime });
      resolvedAttachments.push({
        hash: a.hash,
        path: r.path,
        name: a.name,
        mime: r.mime,
        size: r.size,
      });
    }
    // Capability gate (Phase Y.B requirement #5): hard refuse when
    // the resolved model can't see the attached kind. Surfaces the
    // mismatch BEFORE the engine spends tokens trying to interpret
    // the file. The user nudge is the slash-command for the win.
    const caps = resolvedModel.model.capabilities;
    for (const r of resolvedAttachments) {
      if (r.mime.kind === 'image' && !caps.includes('image')) {
        throw new Error(
          `model '${resolvedModel.providerName}/${resolvedModel.modelId}' does not support image inputs — switch to a vision-capable model first (try /model)`,
        );
      }
      if (r.mime.kind === 'pdf' && !caps.includes('pdf') && !caps.includes('image')) {
        // PDFs ride either as native document blocks (cap=pdf) or as
        // rasterised PNGs (cap=image). Refuse only if neither is on.
        throw new Error(
          `model '${resolvedModel.providerName}/${resolvedModel.modelId}' does not support PDF inputs — switch to a model with 'pdf' or 'image' capability (try /model)`,
        );
      }
    }
    logger.info({
      msg: 'chat.attachments.resolved',
      agent,
      session,
      count: resolvedAttachments.length,
      kinds: resolvedAttachments.map((r) => r.mime.kind),
    });
  }

  const inputMeta =
    inputModality === 'voice'
      ? {
          modality: 'voice' as const,
          transcribed: true,
          ...(sttProvider ? { sttProvider } : {}),
        }
      : undefined;

  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: engine.name,
    text,
    ...(fromAgent ? { from_agent: fromAgent } : {}),
    ...(agentAskCallId ? { agent_ask_call_id: agentAskCallId } : {}),
    ...(ephemeralContext ? { ephemeral: ephemeralContext } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(inputMeta ? { input: inputMeta } : {}),
    ...(autoPlayRequested ? { autoPlayRequested: true } : {}),
  });

  // Live broadcast user_message to ALL session subscribers — A2A
  // inbounds AND self-typed turns. This matters when multiple
  // clients watch the same session (a TUI tail + a web window
  // open at once), or when one client wrote the message and the
  // others should see it appear live. Senders dedupe their own
  // optimistic-local copy by recent-text or local id; receivers
  // just render it.
  if (publishSse) {
    await publishSse({
      event: 'user_message',
      data: {
        text,
        ts: Date.now(),
        ...(fromAgent ? { from_agent: fromAgent } : {}),
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
    // Project block — sits AFTER skills in the cache hierarchy because
    // it's more volatile (changes on /projekt switch — rare but more
    // often than SKILL.md edits). Putting it after skills means a
    // project switch only invalidates from this point onward; selfPointer
    // + persona + skills all stay cached. The block is empty when no
    // project is pinned. Project lookup uses freshly-read from disk so
    // a project_update on the same turn lands in the next turn.
    const projectBlock = await buildProjectBlock(sessionMeta, deps.config);
    const systemPromptForTurn =
      `${selfPointer}${subContextNote}\n\n---\n\n${persona.systemPrompt}${skillsBlock}${projectBlock}`;

    logger.info({
      msg: 'turn.engine_init',
      turnId,
      agent,
      session,
      provider: resolvedModel.providerName,
      model: resolvedModel.modelId,
      engine: resolvedModel.provider.engine,
      historyEvents: history.length,
      memoryInjectedCount,
    });

    const stream = runTurnWithFallback({
      primary: resolvedModel,
      fallbackRef: persona.fallback,
      config: deps.config,
      baseInput: {
        agent,
        session,
        systemPrompt: systemPromptForTurn,
        ephemeralContext,
        // Pass the project block separately so codex-cli (which drops
        // systemPrompt on resumed sessions) can inline it via the
        // user-message-prefix path. claude-cli + openai-compatible
        // already see it via systemPrompt and ignore this field.
        ...(projectBlock ? { projectContext: projectBlock } : {}),
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
        idleTimeoutMs: pickIdleTimeoutForEngine(
          deps.config.engineWatchdog,
          resolvedModel.provider.engine,
        ),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        ...(signal ? { signal } : {}),
        ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
      },
    });

    const serialize = publishSse ? createTurnSerializer() : null;
    let firstEventLogged = false;
    let sawTurnEnd = false;
    let lastSeenEngine: string = resolvedModel.provider.engine;
    let streamTurnId: string | undefined;
    for await (const ev of stream) {
      if (!firstEventLogged) {
        firstEventLogged = true;
        logger.info({
          msg: 'turn.first_event',
          turnId,
          agent,
          session,
          kind: ev.kind,
          msSinceStart: Date.now() - start,
        });
      }
      if ('engine' in ev && typeof ev.engine === 'string' && ev.engine.length > 0) {
        lastSeenEngine = ev.engine;
      }
      // Bug 2026-05-17 Rene: some engines/models hallucinate
      // text-format `<tool_call>{…}</tool_call>` markup inside
      // assistant text (instead of going through the engine's
      // structured tool_use channel). That XML survives the wire and
      // the JSON body lands in the chat bubble as a wall of text.
      // Normalize on the final assistant_message; deltas pass through
      // unchanged because XML boundaries can split across delta chunks
      // (the bubble flips to the final-message text on turn_end so a
      // brief streaming flicker is fine).
      if (ev.kind === 'assistant_message') {
        const sanitized = sanitizeAssistantText(ev.text);
        if (sanitized.matches > 0) {
          logger.warn({
            msg: 'turn.hallucinated_tool_call_xml',
            turnId,
            agent,
            session,
            engine: lastSeenEngine,
            model: resolvedModel.modelId,
            matches: sanitized.matches,
            originalLength: ev.text.length,
            sanitizedLength: sanitized.text.length,
          });
          ev.text = sanitized.text;
        }
      }
      if (ev.kind !== 'assistant_delta') {
        await appendEvent(agent, session, ev);
      }
      if (ev.kind === 'turn_start' && typeof ev.turnId === 'string') {
        streamTurnId = ev.turnId;
      }
      if (ev.kind === 'turn_end') {
        sawTurnEnd = true;
        if (ev.usage) lastUsage = ev.usage;
        if (typeof ev.turnId === 'string') streamTurnId = ev.turnId;
      }
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
    // Defense in depth: if the stream ended cleanly but no turn_end was
    // ever yielded, the session JSONL would be left with an orphan
    // turn_start. healOrphanToolCalls fixes the tool-call case; this
    // covers the turn_start case symmetrically.
    if (!sawTurnEnd) {
      logger.warn({
        msg: 'turn.missing_turn_end',
        turnId,
        agent,
        session,
        engine: lastSeenEngine,
        hint: 'engine stream ended without yielding turn_end; persisting synthetic close',
      });
      await appendEvent(agent, session, {
        kind: 'error',
        ts: Date.now(),
        engine: lastSeenEngine,
        message: 'engine stream ended without turn_end (synthetic close)',
      });
      await appendEvent(agent, session, {
        kind: 'turn_end',
        ts: Date.now(),
        engine: lastSeenEngine,
        turnId: `t-${Date.now()}`,
      });
    }

    // ── Auto-TTS hook ─────────────────────────────────────────────────
    // Gates (all must hold):
    //   (1) config.tts.enabled
    //   (2) input modality was voice
    //   (3) client requested auto-play for this turn
    //   (4) finalText is present + sanitizer doesn't skip
    // Fire-and-forget: TTS generation can take 1-3s, we don't block
    // the turn return. The audio arrives over SSE as assistant_audio
    // when ready (and is appended to JSONL).
    const ttsCfg = deps.config.tts;
    if (
      ttsCfg?.enabled &&
      inputModality === 'voice' &&
      autoPlayRequested &&
      finalText.length > 0 &&
      streamTurnId
    ) {
      const capturedTurnId = streamTurnId;
      void generateAutoTts({
        agent,
        session,
        turnId: capturedTurnId,
        text: finalText,
        engine: lastSeenEngine,
        config: deps.config,
        publishSse,
        parentTurnId: turnId,
      }).catch((err) => {
        logger.warn({
          msg: 'turn.auto_tts_failed',
          turnId,
          agent,
          session,
          err: (err as Error).message,
        });
      });
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    logger.error({
      msg: 'turn.failed',
      turnId,
      agent,
      session,
      err: errorMessage,
      msSinceStart: Date.now() - start,
    });
    // Persist the failure into the session JSONL so the next turn can
    // run cleanly. Without these synthetic records, an engine that
    // throws mid-stream (claude-cli watchdog escape, codex SIGTERM,
    // openai-compat fetch-abort, …) leaves the session log dangling at
    // an unmatched turn_start or tool_call — the queue/lock release
    // happens in the outer finally but the persisted state stays broken
    // until healOrphanToolCalls fires on the next user turn. Surfacing
    // an explicit `error` + `turn_end` here makes the failure visible
    // and ends the turn properly. Best-effort: any append failure is
    // logged but does not re-throw so the outer finally still releases.
    try {
      await appendEvent(agent, session, {
        kind: 'error',
        ts: Date.now(),
        engine: resolvedModel.provider.engine,
        message: `turn aborted: ${errorMessage}`,
      });
      await appendEvent(agent, session, {
        kind: 'turn_end',
        ts: Date.now(),
        engine: resolvedModel.provider.engine,
        turnId: `t-failed-${Date.now()}`,
      });
    } catch (persistErr) {
      logger.error({
        msg: 'turn.failed_persist_failed',
        turnId,
        agent,
        session,
        err: String(persistErr),
        hint: 'could not append synthetic error+turn_end on turn failure; healOrphanToolCalls will run on next user turn',
      });
    }
    if (publishSse) {
      await publishSse({
        event: 'status',
        data: { msg: `turn failed: ${errorMessage}` },
      });
    }
  }

  // Project-focus diff broadcast. The HTTP routes (POST/DELETE /project)
  // publish a 'project' SSE event immediately because they own the
  // write. The tool path (agent calls project_focus via MCP child)
  // can't publish — the child has no SSE access — so we'd otherwise
  // rely on each client refetching after every chat:final. That
  // refetch is fragile (timing, projectsEnabled flag, race against
  // header re-render); reports from 2026-05-19 showed the TUI chip
  // staying stale until agent/session switch. Compare turn-start vs
  // turn-end projectSlug here and emit the SSE event ourselves when
  // they differ — covers tool-path unpins/pins reliably for any
  // engine (claude-cli, codex-cli, openai-compatible).
  try {
    const startSlug =
      typeof sessionMeta.projectSlug === 'string' ? sessionMeta.projectSlug : null;
    const freshMeta = await deps.sessionMetaStore.get(agent, session);
    const endSlug =
      typeof freshMeta.projectSlug === 'string' ? freshMeta.projectSlug : null;
    if (startSlug !== endSlug && publishSse) {
      await publishSse({
        event: 'project',
        data: { from: startSlug, to: endSlug, via: 'tool' },
      });
    }
  } catch (err) {
    logger.warn({
      msg: 'turn.project_diff_publish_failed',
      turnId,
      agent,
      session,
      err: (err as Error).message,
    });
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

  logger.info({
    msg: errorMessage ? 'turn.ended_degraded' : 'turn.completed',
    turnId,
    agent,
    session,
    ms: Date.now() - start,
    finalTextLen: finalText.length,
    tokensIn: lastUsage?.tokens_in,
    tokensOut: lastUsage?.tokens_out,
    ...(errorMessage ? { err: errorMessage } : {}),
  });

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
