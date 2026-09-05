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

/** One image or video made (or announced) during a turn. Carried on
 *  ChatTurnResult so a spawn caller gets the artifact paths without
 *  reading the sub's transcript — the final text is the model's word,
 *  the media list is the tool's (2026-09-05 spielberg report: three
 *  images on disk, final answer a loop-marker, caller had to file_list). */
export interface ChatTurnMedia {
  type: 'image' | 'video';
  id: string;
  /** Absolute path in the canonical media directory. */
  path: string;
  filename: string;
  mime: string;
  prompt: string;
  /** Absolute URL path on the somora server (`/media/<id>/file`). */
  url: string;
}

/** Runtime-derived verdict on a turn — never read from model text.
 *  completed: model answered. partial: the engine had to force a
 *  no-tools finish (round cap / tool budget / scaffold leak) and the
 *  model then answered. degraded: finalText is a harness marker or
 *  empty — the model never produced an answer. failed: engine error. */
export type ChatTurnOutcome = 'completed' | 'partial' | 'degraded' | 'failed';

export interface ChatTurnResult {
  finalText: string;
  outcome: ChatTurnOutcome;
  /** Why the outcome is partial/degraded (round_cap, tool_budget,
   *  scaffold_leak, scaffold_stripped, force_summary_failed,
   *  round_cap_no_answer, empty_answer). */
  outcome_reason?: string;
  /** Tool calls the engine made this turn (counted from tool_call events). */
  tool_calls: number;
  /** Tool-call rounds, where the engine reports them. */
  rounds?: number;
  /** Files created or edited via file_write / file_patch this turn,
   *  from the tool calls that returned without error. Remote targets
   *  are prefixed `<resource>:`. */
  files_written?: string[];
  /** Media generated during the turn (images, finished videos), oldest
   *  first. Absent when the turn produced none or media is not
   *  configured. Independent of finalText: present even when the model
   *  failed to phrase an answer. */
  media?: ChatTurnMedia[];
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
  /** Present when the persona's fallback model answered instead of the
   *  primary. `provider`/`model` above already reflect the fallback. */
  fallback?: { requested: string; actual: string; reason: string };
  error?: string;
}
