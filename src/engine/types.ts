import type { CompactionConfig } from '../compaction/types.ts';
import type { AgentLoopConfig, ResolvedModel } from '../config/types.ts';
import type { ToolInvoker } from '../tools/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

// Per-session metadata, free-form. Engines stash their own internas here
// (e.g. claude-cli writes sdkSessionId). Server-side bookkeeping
// (createdAt, slug, ...) also lives here.
export type SessionMeta = Record<string, unknown>;

export interface SessionMetaStore {
  get(agent: string, session: string): Promise<SessionMeta>;
  set(agent: string, session: string, meta: SessionMeta): Promise<void>;
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
}

export interface AgentEngine {
  /** Engine name = matches Provider.engine ('claude-cli', 'openai-compatible'). */
  readonly name: string;
  runTurn(input: TurnInput): AsyncIterable<NormalizedEvent>;
}
