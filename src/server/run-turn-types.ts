// Types extracted to break a circular import: run-turn.ts uses these,
// run-turn-fallback.ts (in turn) uses NormalizedEvent which is fine,
// and the deps interface uses ToolRegistry which we'd otherwise pull
// in via run-turn → tools/index → server/index → run-turn.

import type { Config, ThinkingLevel } from '../config/types.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import type { ToolRegistry } from '../tools/index.ts';

export interface ChatTurnResolveDeps {
  config: Config;
  sessionMetaStore: SessionMetaStore;
  tools: ToolRegistry;
  /** Reset the auto-dream idle timer for this agent. Server boot wires
   *  it to autoDreamWorker.resetActivity. */
  onActivity: (agent: string) => void;
}

export interface ChatTurnResult {
  finalText: string;
  usage?: {
    tokens_in: number;
    tokens_out: number;
    tokens_in_cached?: number;
    tokens_out_reasoning?: number;
  };
  contextWindow: number;
  provider: string;
  model: string;
  thinkingActive: boolean;
  thinkingLevel?: ThinkingLevel;
  ms: number;
  error?: string;
}
