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
}

export interface AgentEngine {
  /** Engine name = matches Provider.engine ('claude-cli', 'openai-compatible'). */
  readonly name: string;
  runTurn(input: TurnInput): AsyncIterable<NormalizedEvent>;
}
