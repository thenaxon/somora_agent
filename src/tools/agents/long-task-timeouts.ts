// Module-level cache of the long-task timeout knobs from
// config.agentLoop.{longTaskDefaultTimeoutMs,longTaskMaxTimeoutMs}.
//
// Why module-level: ToolDefinition.timeoutFromInput / maxTimeoutMs are
// evaluated by the engine without a ToolContext (the engine doesn't carry
// config into the per-call timeout resolver — see openai-compatible.ts
// ~line 427). Plumbing config into that signature would touch every
// engine adapter; a small module-level cache, populated at server boot
// the same way configureSpawnTools is, keeps the change local.
//
// Fallbacks below match the schema defaults so an MCP child that boots
// before configure() runs (or in test code that skips boot wiring)
// still gets sensible numbers instead of NaN.

import type { Config } from '../../config/types.ts';

const FALLBACK_DEFAULT_MS = 300_000;   // 5 min
const FALLBACK_MAX_MS = 1_800_000;     // 30 min

let cachedDefault = FALLBACK_DEFAULT_MS;
let cachedMax = FALLBACK_MAX_MS;

/**
 * Called once at server boot (and at MCP-child boot) with the loaded
 * config. Subsequent reads via longTaskDefaultMs/longTaskMaxMs return
 * the configured values.
 */
export function configureLongTaskTimeouts(config: Config): void {
  cachedDefault = config.agentLoop.longTaskDefaultTimeoutMs;
  cachedMax = config.agentLoop.longTaskMaxTimeoutMs;
}

export function longTaskDefaultMs(): number {
  return cachedDefault;
}

export function longTaskMaxMs(): number {
  return cachedMax;
}
