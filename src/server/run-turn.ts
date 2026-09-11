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
import type {
  ChatTurnMedia,
  ChatTurnOutcome,
  ChatTurnResolveDeps,
  ChatTurnResult,
} from './run-turn-types.ts';
import { appendEvent, getHistory } from '../storage/sessions.ts';
import { healOrphanToolCalls } from './heal-session.ts';
import { resolveCompactionConfig } from '../compaction/index.ts';
import {
  type Config,
  describeModelRefs,
  listAllModels,
  resolveAnyRef,
  workerChain,
  type ThinkingLevel,
  type SamplingConfig,
} from '../config/types.ts';
import { describeMedia } from '../tools/file/analyze.ts';
import { loadAttachment } from '../multimodal/load.ts';
import { engineRegistry } from '../engine/registry.ts';
import { runTurnWithFallback } from './run-turn-fallback.ts';
import { clearTurnOrigin, setTurnOrigin } from './turn-origin.ts';
import { assembleSystemPrompt } from './prompt-assembly.ts';
import type { ResolvedAttachment } from '../engine/types.ts';
import { resolveAttachmentByHash } from '../attachments/store.ts';
import { listRecords as listMediaRecords, readRecord as readMediaRecord } from '../media/records.ts';
import {
  buildReviewLoopBlock,
  refreshLoopActivity,
  resetWikiCallCounter,
} from '../dream/loop-state.ts';
import { injectMemoryContext } from '../memory/inject.ts';
import { getMemoryManager } from '../memory/registry.ts';
import { logger } from './logger.ts';
import { loadPersona, type Persona } from '../persona/loader.ts';
import { isToolAllowed } from '../tools/gating.ts';
import { createTurnSerializer } from './sse-serializer.ts';
import { sanitizeAssistantText } from './sanitize-assistant-text.ts';
import { synthesize } from '../tts/service.ts';
import { prepareForTts } from '../tts/prepare-for-tts.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { resolveOpenAiReasoning } from '../engine/thinking-params.ts';
import { mergeSampling } from '../engine/sampling.ts';
import { SOMORA_HOME_DIR } from './logger.ts';

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high']);

// Injected into the system prompt when the agent has tools and
// `agentLoop.toolUsageReminder` is on. Kept short and constant — it has
// to earn its place in every single prompt.
// Exported so prompt-effect probes can assemble the same system prompt
// the runtime sends. Measuring a variant that omits it measures a prompt
// nobody ever sees.
export { TOOL_USAGE_REMINDER } from './prompt-assembly.ts';

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
    case 'grok-cli':
      return cfg.grokCliIdleMs;
    case 'openai-compatible':
      return cfg.openaiCompatibleIdleMs;
  }
}

/**
 * Relaxed idle threshold to use while a tool call is outstanding on a CLI
 * engine — the MCP tool timeout, so a legit long tool isn't cut off by
 * the much shorter normal idle watchdog (Juni-Audit 2026-06). Returns
 * undefined for openai-compatible (it disarms the watchdog during its own
 * in-process tool loop instead).
 */
function pickToolIdleTimeoutForEngine(
  config: import('../config/types.ts').Config,
  engine: import('../config/types.ts').EngineName,
): number | undefined {
  switch (engine) {
    case 'claude-cli':
      return config.claudeCli.mcpToolTimeoutMs;
    case 'codex-cli':
      return config.codexCli.toolTimeoutSec * 1000;
    case 'grok-cli':
      // No grok-specific knob (the MCP-side timeout is grok's own); the
      // question here is only "how long may a tool run before the
      // engine counts as wedged", so borrow the larger sibling budget.
      return Math.max(config.claudeCli.mcpToolTimeoutMs, config.codexCli.toolTimeoutSec * 1000);
    case 'openai-compatible':
      return undefined;
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

/** Sampling: model default < agent.yaml < session override, per key. */
export function resolveEffectiveSampling(
  model: { sampling?: SamplingConfig },
  persona: Persona,
  sessionMeta: Record<string, unknown>,
): SamplingConfig | undefined {
  const override = sessionMeta.samplingOverride;
  return mergeSampling(
    model.sampling,
    persona.sampling,
    override && typeof override === 'object' ? (override as Record<string, unknown>) : undefined,
  );
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
  /** A2A: session the asking agent wrote from (id or 'main'). Persists
   *  in user_message.from_session and registers the turn's origin for
   *  agent_ask's reply-back default (src/server/turn-origin.ts). */
  fromSession?: string;
  /** Synthesized inbound marker: when set, this turn's text was
   *  produced by an internal subsystem (today only 'sentinel' — the
   *  trigger runtime injecting a `[Sentinel trigger fired]…` prompt).
   *  Persists in user_message.from_system and on the SSE event, so
   *  clients render the message as a centered system divider rather
   *  than a normal user-bubble. Mutually exclusive with fromAgent. */
  fromSystem?: 'sentinel' | 'tmux' | 'subagent' | 'job' | 'browser' | 'voice';
  /** Media made before this turn that nevertheless belongs to it —
   *  a finished video announced by a wake-up. See publishTurnMedia. */
  attachMediaIds?: string[];
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

/**
 * Publish the images generated during a turn so they show up in the
 * user's chat.
 *
 * Found by querying the image records for this agent+session created
 * since the turn started, rather than by watching tool results go by.
 * That's deliberate: with claude-cli / codex-cli the tool runs inside
 * an MCP CHILD PROCESS, so an in-memory hook here would see nothing and
 * images would appear in chat for some engines but not others. The
 * records are on disk and the same for every engine.
 *
 * The window is [turnStartedAt, now]. A concurrent turn in the same
 * session could in principle overlap, but turns in a session are
 * serialized by the turn lock, so the only overlap available is a
 * subagent — which carries its own session.
 */
async function publishTurnMedia(args: {
  agent: string;
  session: string;
  turnId: string;
  engine: string;
  startedAt: number;
  /**
   * Media that belongs to this turn but was NOT made during it. A video
   * render finishes minutes after the turn that ordered it, and the
   * turn that reports it is a wake-up started afterwards — so the file
   * predates its own announcement and the time window below would miss
   * it. Naming it explicitly is the honest fix; widening the window
   * would sweep in whatever else happened to be lying around.
   */
  attachMediaIds?: string[];
  publishSse?: (event: SseEvent) => Promise<void>;
}): Promise<ChatTurnMedia[]> {
  const { agent, session, turnId, engine, startedAt, publishSse } = args;
  const { items } = await listMediaRecords({
    agent,
    session,
    since: new Date(startedAt).toISOString(),
    limit: 50,
  });
  const seen = new Set(items.map((i) => i.id));
  for (const id of args.attachMediaIds ?? []) {
    if (seen.has(id)) continue;
    const extra = await readMediaRecord(id);
    if (extra) {
      items.push(extra);
      seen.add(id);
    }
  }
  if (items.length === 0) return [];

  // listRecords returns newest first; chat should read in the order
  // they were made.
  const ordered = [...items].reverse();
  const evt = {
    kind: 'assistant_media' as const,
    ts: Date.now(),
    engine,
    turnId,
    media: ordered.map((m) => ({
      type: (m.kind ?? 'image') as 'image' | 'video',
      id: m.id,
      prompt: m.prompt,
      mime: m.mime,
      filename: m.filename,
      url: `/media/${m.id}/file`,
      ...(m.thumbPath ? { thumbUrl: `/media/${m.id}/thumb` } : {}),
      ...(m.durationSec !== undefined ? { durationSec: m.durationSec } : {}),
    })),
  };
  await appendEvent(agent, session, evt);
  if (publishSse) {
    await publishSse({ event: 'assistant_media', data: { turnId, media: evt.media } });
  }
  logger.info({ msg: 'turn.media_published', turnId, agent, session, count: evt.media.length });
  return ordered.map((m) => ({
    type: (m.kind ?? 'image') as 'image' | 'video',
    id: m.id,
    path: m.path,
    filename: m.filename,
    mime: m.mime,
    prompt: m.prompt,
    url: `/media/${m.id}/file`,
  }));
}

export async function runChatTurn(args: RunChatTurnArgs): Promise<ChatTurnResult> {
  const start = Date.now();
  const {
    agent,
    session,
    text,
    fromAgent,
    fromSession,
    fromSystem,
    attachMediaIds,
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
  // Lower bound for the generated-images lookup at the end of the
  // turn. Taken before any engine work so an image produced by the
  // very first tool call is inside the window.
  const turnStartedAt = Date.now();
  /** Set when run-turn-fallback re-ran this turn on the fallback model —
   *  the phase:'end' payload and the result report the ACTUAL model. */
  let turnFallback: ChatTurnResult['fallback'];
  logger.info({
    msg: 'turn.started',
    turnId,
    agent,
    session,
    subagentDepth,
    fromAgent: fromAgent ?? null,
    fromSession: fromSession ?? null,
    textLen: text.length,
    attachmentCount: attachments?.length ?? 0,
  });
  // Reply-back routing for agent_ask (see turn-origin.ts). Reset on
  // every turn so a human turn following an A2A one never inherits it.
  setTurnOrigin(agent, session, fromAgent && fromSession ? { agent: fromAgent, session: fromSession } : null);

  const persona = await loadPersona(agent);
  if (!persona) {
    throw new Error(`agent '${agent}' not found`);
  }

  const sessionMeta = await deps.sessionMetaStore.get(agent, session);
  const effectiveMetaForResolve = modelOverride
    ? { ...sessionMeta, modelOverride }
    : sessionMeta;
  const resolvedModel = resolveEffectiveModel(deps.config, persona, effectiveMetaForResolve);
  if (!resolvedModel) {
    const ref = effectiveMetaForResolve.modelOverride ?? persona.model ?? '(none)';
    throw new Error(
      `model '${String(ref)}' for agent '${agent}' cannot be resolved from config.yaml — ` +
        `use an alias or provider/modelId exactly as configured. Available: ${describeModelRefs(deps.config)}`,
    );
  }
  const engine = engineRegistry[resolvedModel.provider.engine];
  if (!engine) {
    throw new Error(`no engine '${resolvedModel.provider.engine}' registered`);
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
  /** Worker descriptions of files the model cannot see, appended to the
   *  message the engine gets. The persisted user_message keeps the
   *  original attachment refs, so the clients still show the picture. */
  const describedAttachments: string[] = [];
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
    // Capability gate. A model that cannot see the attached kind used to
    // end the turn with "switch models". That is exactly the situation
    // the vision worker exists for (Rene 2026-09-10), so the worker
    // describes the file and its text rides along with the message. The
    // refusal stays for the case where no worker is configured.
    //
    // PDFs ride either as native document blocks (cap=pdf) or as
    // rasterised PNGs (cap=image), so either capability is enough.
    const caps = resolvedModel.model.capabilities;
    const unseeable = resolvedAttachments.filter(
      (r) =>
        (r.mime.kind === 'image' && !caps.includes('image')) ||
        (r.mime.kind === 'pdf' && !caps.includes('pdf') && !caps.includes('image')),
    );
    if (unseeable.length > 0) {
      const modelLabel = `${resolvedModel.providerName}/${resolvedModel.modelId}`;
      const kinds = [...new Set(unseeable.map((r) => r.mime.kind))].join('/');
      if (workerChain(deps.config.vision.worker).length === 0) {
        throw new Error(
          `model '${modelLabel}' does not support ${kinds} inputs — switch to a capable model (try /model), ` +
            `or configure config.vision.worker so somora can have a vision worker describe attachments for it`,
        );
      }
      for (const r of unseeable) {
        let described;
        try {
          const att = await loadAttachment(r.path, {
            maxImageBytes: deps.config.attachments.maxImageBytes,
            maxPdfBytes: deps.config.attachments.maxPdfBytes,
            maxTextBytes: deps.config.attachments.maxTextBytes,
          });
          described = await describeMedia({
            att,
            config: deps.config,
            agent,
            session,
            caller: 'chat_attachment',
          });
        } catch (err) {
          throw new Error(
            `model '${modelLabel}' cannot see '${r.name}', and the vision worker could not describe it either: ` +
              `${(err as Error).message}`,
          );
        }
        // Second-hand sight, and the model is told so. A described
        // picture that pretends to be the picture is how an agent ends
        // up asserting detail nobody ever saw.
        describedAttachments.push(
          `[attachment ${r.name} (${r.mime.mimeType}) — your model cannot see ${r.mime.kind} files, ` +
            `so somora had the vision worker ${described.worker} look at it and report back:\n` +
            `${described.analysis}\n` +
            `This is a description, not the file. Say so when the exact detail matters.]`,
        );
        logger.info({
          msg: 'chat.attachment.described',
          agent,
          session,
          file: r.name,
          kind: r.mime.kind,
          model: modelLabel,
          worker: described.worker,
          ms: described.ms,
        });
      }
      // The engine must not receive what it cannot read.
      for (const r of unseeable) {
        const i = resolvedAttachments.indexOf(r);
        if (i >= 0) resolvedAttachments.splice(i, 1);
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
    ...(fromAgent && fromSession ? { from_session: fromSession } : {}),
    ...(fromSystem ? { from_system: fromSystem } : {}),
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
        turnId,
        ...(fromAgent ? { from_agent: fromAgent } : {}),
        ...(fromAgent && fromSession ? { from_session: fromSession } : {}),
        ...(fromSystem ? { from_system: fromSystem } : {}),
        ...(agentAskCallId ? { agent_ask_call_id: agentAskCallId } : {}),
      },
    });
  }

  // Reset the agent's auto-dream timer — sub-flows count as activity.
  deps.onActivity(agent);

  const modelSupportsReasoning = resolvedModel.model.capabilities.includes('reasoning');
  const effectiveThinking = resolveEffectiveThinking(persona, sessionMeta);
  const effectiveSampling = resolveEffectiveSampling(resolvedModel.model, persona, sessionMeta);
  // What the openai-compatible engine will actually put on the wire for
  // this level (per-model `reasoning.levels`). Only sent to clients when
  // it differs from the level itself, so the badge can read `high→xhigh`.
  const thinkingWire =
    effectiveThinking && modelSupportsReasoning && resolvedModel.provider.engine === 'openai-compatible'
      ? (resolveOpenAiReasoning(effectiveThinking, resolvedModel.model).value ?? 'off')
      : undefined;
  const thinkingWireField =
    thinkingWire !== undefined && thinkingWire !== effectiveThinking ? { wire: thinkingWire } : {};
  if (publishSse) {
    const startThinkingPayload = effectiveThinking
      ? { level: effectiveThinking, active: modelSupportsReasoning, ...thinkingWireField }
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
        /** Window the engine reports for itself, when it does. */
        context_window?: number;
      }
    | undefined;
  let finalText = '';
  let turnMedia: ChatTurnMedia[] = [];
  // Outcome bookkeeping (ChatTurnResult.outcome / tool_calls / rounds /
  // files_written) — all from events, none from model text.
  let toolCallCount = 0;
  let turnRounds: number | undefined;
  let forcedFinal: string | undefined;
  let degradedReason: string | undefined;
  const pendingWrites = new Map<string, string>();
  const filesWritten: string[] = [];
  let errorMessage: string | undefined;
  // The engine's own turn id (`t-…`), learned from its turn_start. Kept
  // outside the try so the failure path can stamp its turn_error with
  // it — the client pairs the error block to the right turn by this.
  let streamTurnId: string | undefined;

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
      turnId,
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
    // Per-agent gating (agent.yaml tools:) filters the LIST the model
    // sees; invoke() stays unfiltered by design — a queued call for a
    // just-denied tool failing mid-turn would be more confusing than
    // letting it finish. The MCP child applies the same filter for the
    // CLI engines (src/tools/gating.ts is the single matcher).
    const availableTools = (await deps.tools.listAvailable(toolCtx)).filter((t) =>
      isToolAllowed(t.name, t.toolset, persona.toolGating),
    );
    const toolInvoker = {
      list: () => availableTools,
      invoke: (name: string, input: unknown) => deps.tools.invoke(name, input, toolCtx),
    };

    // One assembly for the real turn and for GET /agents/:agent/prompt-
    // preview (web Agent window) — see prompt-assembly.ts for the order
    // and the cache rationale per block.
    const assembled = await assembleSystemPrompt({
      agent,
      session,
      persona,
      sessionMeta,
      deps,
      subagentDepth,
      toolCount: availableTools.length,
    });
    const projectBlock = assembled.projectBlock;
    const systemPromptForTurn = assembled.text;

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
      fallbackRefs: persona.fallback,
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
        userMessage: describedAttachments.length > 0 ? `${text}\n\n${describedAttachments.join('\n\n')}` : text,
        ...(fromAgent ? { fromAgent } : {}),
        ...(fromAgent && fromSession ? { fromSession } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        history,
        metaStore: deps.sessionMetaStore,
        availableModels: listAllModels(deps.config),
        compactionConfig: resolveCompactionConfig(deps.config),
        tools: toolInvoker,
        // External MCP servers → CLI engines add one somora-<name>
        // proxy child per entry (design §4.4). Per-agent gating happens
        // inside the child (same matcher as the toolInvoker filter
        // above), so the entry list itself is agent-independent.
        externalMcpServers: Object.entries(deps.config.mcp.servers)
          .filter(([, cfg]) => cfg.enabled)
          .map(([name, cfg]) => ({ name, timeoutMs: cfg.timeoutMs })),
        agentLoopConfig: agentLoopOverride
          ? { ...deps.config.agentLoop, ...agentLoopOverride }
          : deps.config.agentLoop,
        idleTimeoutMs: pickIdleTimeoutForEngine(
          deps.config.engineWatchdog,
          resolvedModel.provider.engine,
        ),
        ...(() => {
          const t = pickToolIdleTimeoutForEngine(deps.config, resolvedModel.provider.engine);
          return t !== undefined ? { toolIdleTimeoutMs: t } : {};
        })(),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        ...(effectiveSampling ? { sampling: effectiveSampling } : {}),
        captureThinking: deps.config.thinkingContent.capture,
        ...(signal ? { signal } : {}),
        ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
      },
    });

    const serialize = publishSse ? createTurnSerializer() : null;
    let firstEventLogged = false;
    let sawTurnEnd = false;
    let lastSeenEngine: string = resolvedModel.provider.engine;
    let fallbackInfo: ChatTurnResult['fallback'];
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
      // Thinking content: one server-side gate for SSE + JSONL (three
      // gates rule — clients need no switch of their own), and a cap on
      // what is persisted. Deltas are never persisted, like assistant
      // deltas.
      if (ev.kind === 'thinking_delta' || ev.kind === 'thinking_message') {
        if (!deps.config.thinkingContent.capture) continue;
        if (ev.kind === 'thinking_message') {
          const cap = deps.config.thinkingContent.maxChars;
          if (ev.text.length > cap) {
            ev.text = ev.text.slice(0, cap).trimEnd() + '…';
            ev.truncated = true;
          }
        }
      }
      if (ev.kind !== 'assistant_delta' && ev.kind !== 'thinking_delta') {
        await appendEvent(agent, session, ev);
      }
      // An error event that survives the fallback chain is this turn's
      // outcome. Without this the variable was only ever set by the
      // outer catch, so a turn that ended on a streamed provider error
      // was logged as turn.completed and reported success to whoever
      // asked for it — a subagent caller, the A2A result, the audit
      // (2026-09-09 and 2026-09-10 reports). First one wins: later
      // errors are usually consequences of the first.
      if (ev.kind === 'error' && !errorMessage) {
        errorMessage = ev.message;
        logger.warn({
          msg: 'turn.engine_error',
          turnId,
          agent,
          session,
          engine: ev.engine,
          providerError: ev.providerError === true,
          err: ev.message,
        });
      }
      if (ev.kind === 'turn_start' && typeof ev.turnId === 'string') {
        streamTurnId = ev.turnId;
        if (publishSse) {
          await publishSse({ event: 'turn_started', data: { turnId: ev.turnId } });
        }
      }
      if (ev.kind === 'model_fallback') {
        fallbackInfo = {
          requested: ev.requested,
          actual: ev.actual,
          reason: ev.reason,
          ...(ev.hops ? { hops: ev.hops } : {}),
        };
        turnFallback = fallbackInfo;
      }
      if (ev.kind === 'turn_end') {
        sawTurnEnd = true;
        if (ev.usage) lastUsage = ev.usage;
        if (typeof ev.turnId === 'string') streamTurnId = ev.turnId;
        if (typeof ev.rounds === 'number') turnRounds = ev.rounds;
        if (ev.forced_final) forcedFinal = ev.forced_final;
        if (ev.degraded) degradedReason = ev.degraded.reason;
      }
      if (ev.kind === 'tool_call') {
        toolCallCount += 1;
        if (ev.tool === 'file_write' || ev.tool === 'file_patch') {
          const inp = ev.input as { path?: unknown; target?: unknown } | null;
          if (inp && typeof inp.path === 'string') {
            const target = typeof inp.target === 'string' && inp.target !== 'local' ? `${inp.target}:` : '';
            pendingWrites.set(ev.callId, `${target}${inp.path}`);
          }
        }
      }
      if (ev.kind === 'tool_result') {
        const requested = pendingWrites.get(ev.callId);
        if (requested !== undefined) {
          pendingWrites.delete(ev.callId);
          // Prefer the path the tool resolved (absolute, workspace-
          // relative input expanded) over the one the model typed.
          const out = ev.output as { path?: unknown } | null;
          const resolved = out && typeof out.path === 'string' ? out.path : undefined;
          const remotePrefix = requested.includes(':') ? requested.slice(0, requested.indexOf(':') + 1) : '';
          const path = resolved ? `${remotePrefix}${resolved}` : requested;
          if (!ev.error && !filesWritten.includes(path)) filesWritten.push(path);
        }
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
        if (ev.kind === 'error') {
          // The serializer keeps the `status` line for older clients;
          // this adds the turn id so the failure lands in its turn.
          await publishSse({
            event: 'turn_error',
            data: {
              ...(streamTurnId ? { turnId: streamTurnId } : {}),
              message: ev.message,
              engine: ev.engine,
            },
          });
        }
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

    // ── Generated-media hook ──────────────────────────────────────────
    // Anything produced during this turn — an image made in it, or a
    // video whose render finished and brought us back here — goes to
    // the client as an append-only event paired to the bubble.
    // Runs regardless of whether the agent mentioned the image in its
    // reply: the user asked for a picture, so the picture belongs in
    // the conversation, and depending on the agent to remember makes
    // "Done!" with nothing to look at the failure mode.
    //
    // Awaited (an index read, milliseconds) so the list lands on the
    // ChatTurnResult for spawn callers — but non-fatal: a turn that
    // produced a real image must not be reported as failed because the
    // gallery index couldn't be read.
    // Gated on EITHER surface: a setup with video but no images still
    // has media to publish, and gating on images alone meant a
    // finished video never reached the chat at all.
    if ((deps.config.imageGen?.enabled || deps.config.videoGen?.enabled) && streamTurnId) {
      const capturedMediaTurnId = streamTurnId;
      turnMedia = await publishTurnMedia({
        agent,
        session,
        turnId: capturedMediaTurnId,
        engine: lastSeenEngine,
        startedAt: turnStartedAt,
        ...(attachMediaIds ? { attachMediaIds } : {}),
        publishSse,
      }).catch((err) => {
        logger.warn({
          msg: 'turn.media_publish_failed',
          turnId,
          agent,
          session,
          err: (err as Error).message,
        });
        return [] as ChatTurnMedia[];
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
      await publishSse({
        event: 'turn_error',
        data: {
          ...(streamTurnId ? { turnId: streamTurnId } : {}),
          message: `turn aborted: ${errorMessage}`,
          engine: resolvedModel.provider.engine,
        },
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
      ? { level: effectiveThinking, active: modelSupportsReasoning, ...thinkingWireField }
      : undefined;
    const actualRef = turnFallback ? splitModelRef(turnFallback.actual) : undefined;
    await publishSse({
      event: 'agent',
      data: {
        phase: 'end',
        ...(lastUsage ? { usage: lastUsage } : {}),
        // A CLI engine knows its own window; the configured value is
        // somora's guess at a cap it does not enforce (2026-09-11).
        contextWindow: lastUsage?.context_window ?? resolvedModel.model.contextWindow,
        provider: actualRef?.provider ?? resolvedModel.providerName,
        model: actualRef?.model ?? resolvedModel.modelId,
        ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
        ...(turnFallback ? { fallback: turnFallback } : {}),
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

  clearTurnOrigin(agent, session);
  const actualForResult = turnFallback ? splitModelRef(turnFallback.actual) : undefined;
  const outcome: ChatTurnOutcome = errorMessage
    ? 'failed'
    : degradedReason
      ? 'degraded'
      : finalText.trim().length === 0
        ? 'degraded'
        : forcedFinal
          ? 'partial'
          : 'completed';
  const outcomeReason =
    outcome === 'failed'
      ? undefined
      : (degradedReason ?? (finalText.trim().length === 0 ? 'empty_answer' : forcedFinal));
  return {
    finalText,
    outcome,
    ...(outcomeReason ? { outcome_reason: outcomeReason } : {}),
    tool_calls: toolCallCount,
    ...(turnRounds !== undefined ? { rounds: turnRounds } : {}),
    ...(filesWritten.length > 0 ? { files_written: filesWritten } : {}),
    ...(turnMedia.length > 0 ? { media: turnMedia } : {}),
    usage: lastUsage,
    contextWindow: lastUsage?.context_window ?? resolvedModel.model.contextWindow,
    provider: actualForResult?.provider ?? resolvedModel.providerName,
    model: actualForResult?.model ?? resolvedModel.modelId,
    thinkingActive: modelSupportsReasoning && Boolean(effectiveThinking),
    thinkingLevel: effectiveThinking,
    ms: Date.now() - start,
    ...(turnFallback ? { fallback: turnFallback } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

/** `provider/modelId` → parts (modelIds may themselves contain '/'). */
function splitModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  return slash < 0 ? { provider: '', model: ref } : { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export type { ChatTurnResult } from './run-turn-types.ts';
