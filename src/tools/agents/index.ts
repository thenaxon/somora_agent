// A2A tool bundle. Modus 1 (sealed-task delegation) lands here in 6b.
// Modus 2 (live agent_ask messaging) follows in 6c.

import { spawnSubagent, spawnSubagents } from './spawn.ts';
import { subagentResult, subagentStatus } from './status.ts';
import type { ToolDefinition } from '../types.ts';

export { configureSpawnTools, spawnSubagent, spawnSubagents } from './spawn.ts';
export { subagentResult, subagentStatus } from './status.ts';

export function agentTools(): ToolDefinition[] {
  return [
    spawnSubagent,
    spawnSubagents,
    subagentStatus,
    subagentResult,
  ] as ToolDefinition[];
}
