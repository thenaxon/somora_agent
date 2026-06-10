import type { CompactionConfig } from '../compaction/types.ts';
import type { AgentLoopConfig, ResolvedModel, ThinkingLevel } from '../config/types.ts';
import type { ToolInvoker } from '../tools/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { DetectedMime } from '../multimodal/mime.ts';

/**
 * User-attached file resolved to a usable on-disk path. Constructed
 * by the server (run-turn) from the JSONL `attachments[]` refs before
 * the engine adapter runs. Phase Y.B.
 */
export interface ResolvedAttachment {
  hash: string;
  /** Absolute path under ~/.somora/attachments/. */
  path: string;
  /** Original client-supplied filename, display-only. */
  name: string;
  mime: DetectedMime;
  size: number;
}

// Per-session metadata, free-form. Engines stash their own internas here
// (e.g. claude-cli writes sdkSessionId). Server-side bookkeeping
// (createdAt, slug, ...) also lives here.
//
// Well-known optional fields (documented here so future-me doesn't
// re-discover them by grep):
//   - sdkSessionId       claude-cli — SDK session ID for resume
//   - codexSessionId     codex-cli — thread ID for resume
//   - engine             last engine that wrote to this session
//   - slug               session slug (set at create)
//   - createdAt          ISO timestamp at create
//   - modelOverride      session-level model override (set via /model)
//   - thinkingOverride   session-level thinking-level override
//   - archived           true if user/reset archived this session
//   - archivedAt         ISO timestamp at archive
//   - archiveReason      human note
//   - cache              CachedStats for listSessions perf
//   - projectSlug        currently-pinned project (Phase Projects v1)
//   - projectLinkedAt    ISO timestamp at last focus change
//   - dreamReadThroughTs REM coverage marker
//
// Kept as a free-form Record so adding a field doesn't require coordinated
// migrations across all writers.
export type SessionMeta = Record<string, unknown>;

export interface SessionMetaStore {
  get(agent: string, session: string): Promise<SessionMeta>;
  set(agent: string, session: string, meta: SessionMeta): Promise<void>;
  /**
   * Atomic read-merge-write under an in-process per-session lock. `merge`
   * receives the LATEST on-disk meta and returns the new meta to persist.
   * Use this for any field-level update that runs concurrently with other
   * writers (turn-end engine writes, activity marks, stats cache) — a plain
   * get()+set() spreads a stale snapshot and silently reverts whatever
   * another writer persisted in between (Juni-Audit 2026-06 clobber).
   */
  update(
    agent: string,
    session: string,
    merge: (current: SessionMeta) => SessionMeta,
  ): Promise<SessionMeta>;
}

export interface TurnInput {
  agent: string;
  session: string;
  /**
   * Stable per-session content: persona (AGENTS.md/SOUL.md/USER.md) plus
   * any other static instructions. Engines should treat this as cacheable.
   * Does NOT change between turns of the same session — engines that resume
   * an underlying provider session can rely on the provider remembering it.
   */
  systemPrompt: string;
  /**
   * Per-turn ephemeral context — currently the auto-injected memory recall
   * block (DECISION #26), later also dream-mode findings. Engines MUST send
   * this to the model on every turn even when they're resuming an underlying
   * provider session, because the content changes per turn.
   *
   * Empty/undefined means "no ephemeral context for this turn" — engines
   * should not emit any wrapper / delimiter / placeholder in that case.
   */
  ephemeralContext?: string;
  /**
   * Session-pinned project block (Phase Projects v1). When a session has
   * `sessionMeta.projectSlug` set, run-turn renders the project pointer-
   * list via renderProjectBlock() and stashes the result HERE in addition
   * to including it in `systemPrompt`.
   *
   * The duplication is intentional because two engines treat systemPrompt
   * differently across fresh-vs-resume:
   *   - claude-cli, openai-compatible: re-send `systemPrompt` on every
   *     turn → the project block flows in via systemPrompt; this field
   *     is informational and unused.
   *   - codex-cli RESUME: drops systemPrompt entirely (codex remembers
   *     it internally from session-start). On resumed sessions a
   *     mid-session `/projekt` pin would be invisible to the model
   *     unless we inline the block via the user-message-prefix path.
   *     The codex adapter consumes THIS field on the resume branch.
   *
   * Empty/undefined means "no project pinned" — engines should not emit
   * any wrapper. The string is already prefixed with `\n\n---\n\n` from
   * the renderer; just concatenate as-is.
   */
  projectContext?: string;
  userMessage: string;
  history: NormalizedEvent[];
  metaStore: SessionMetaStore;
  resolvedModel: ResolvedModel;
  /**
   * All (provider, model) pairs configured in the server. Used by
   * compaction to pick a worker model whose window can fit the
   * to-be-summarized history (DECISION #21a). Engines that don't run
   * compaction can ignore this field.
   */
  availableModels: ResolvedModel[];
  /**
   * Resolved compaction tunables (config.yaml `compaction:` section, with
   * env-var overrides applied). Server resolves this once at turn-build
   * time so engines don't need to know about config-vs-env precedence.
   */
  compactionConfig: CompactionConfig;
  /**
   * Tool surface for engines that run their own agent-loop (Phase
   * 2-Stufe-C). Currently only the openai-compatible engine uses this —
   * claude-cli and codex-cli configure the somora-memory MCP server as
   * a child process and the CLI handles tool list+invoke internally.
   *
   * Server binds the agent context (memory manager, etc.) into the
   * invoker closure so engines don't have to assemble it themselves.
   * Optional — when absent, the engine runs in plain chat mode.
   */
  tools?: ToolInvoker;
  /**
   * Agent-loop tunables (max rounds, per-tool timeout). Same scope as
   * `tools` — only consumed by engines with their own loop. Resolved
   * server-side from config.yaml `agentLoop:` section.
   */
  agentLoopConfig?: AgentLoopConfig;
  /**
   * Idle-event watchdog timeout in milliseconds. If the engine produces
   * no events (assistant_delta, tool_call, tool_result, …) for this
   * duration, abort the in-flight engine call so the per-session lock
   * releases and the user sees a clean error. Resolved by the server
   * from `config.engineWatchdog.<engineName>IdleMs`. Engines fall back
   * to a built-in safe default when this is undefined.
   */
  idleTimeoutMs?: number;
  /**
   * Effective thinking depth for this turn — server resolves persona
   * default + session override. Engine adapters apply only when the
   * active model has the 'reasoning' capability; otherwise this is
   * dormant and the header surfaces that to the user.
   * 'off' disables thinking; missing means "engine default".
   */
  thinking?: ThinkingLevel;
  /**
   * Agent-to-agent (A2A) sender attribution. When set, the
   * `userMessage` for this turn was written by another agent, not by
   * the human user. Engines prepend a `[Message from agent <name>]`
   * header to the user-message body so the model knows the
   * provenance. Persists in JSONL via NormalizedEvent.user_message.from_agent.
   */
  fromAgent?: string;
  /**
   * When this turn runs inside a spawned sub-agent context, depth is
   * the nesting level (0 = top-level user turn, 1 = first sub, …).
   * Engine adapters use it for the self-pointer block ("you are a sub
   * spawned by …") and for recursion-cap enforcement when a sub itself
   * tries to spawn further subs.
   */
  subagentDepth?: number;
  /**
   * User-cancellation signal. When the TUI presses ESC mid-turn the
   * server registers an AbortController and threads its signal here.
   * Engine adapters should:
   *   - claude-cli: pass to claude-agent-sdk's query() abortController option
   *   - codex-cli: kill the subprocess on abort
   *   - openai-compatible: pass to fetch + chat.completions
   * On abort, emit a final assistant_message with whatever's
   * accumulated so far (or a `[somora] aborted by user` marker if
   * empty) plus a turn_end so the SSE stream closes cleanly.
   */
  signal?: AbortSignal;
  /**
   * Resolved user-attachments for THIS turn (Phase Y.B). When present,
   * engines build a multimodal user-message-content array instead of
   * pure text. Each engine adapter handles its own native shape
   * (claude-cli: ContentBlockParam[]; openai-compatible: chat-completion
   * content parts; codex-cli: --image flags + rasterised PDFs).
   *
   * Past-turn attachments come back via NormalizedEvent.user_message.
   * attachments on history events — engines that replay history
   * (openai-compatible) reconstruct the full content array per turn.
   */
  attachments?: ResolvedAttachment[];
}

export interface AgentEngine {
  /** Engine name = matches Provider.engine ('claude-cli', 'openai-compatible'). */
  readonly name: string;
  runTurn(input: TurnInput): AsyncIterable<NormalizedEvent>;
}
