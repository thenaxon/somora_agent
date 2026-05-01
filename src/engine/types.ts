import type { CompactionConfig } from '../compaction/types.ts';
import type { ResolvedModel } from '../config/types.ts';
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
  systemPrompt: string;
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
}

export interface AgentEngine {
  /** Engine name = matches Provider.engine ('claude-cli', 'openai-compatible'). */
  readonly name: string;
  runTurn(input: TurnInput): AsyncIterable<NormalizedEvent>;
}
