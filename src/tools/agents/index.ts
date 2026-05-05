// A2A tool bundle.
//   Modus 1 (sealed-task delegation, fresh sub-session):
//     spawn_subagent / spawn_subagents / subagent_status /
//     subagent_result / subagent_list  — Phase 6b
//   Modus 2 (live messaging into target's existing session):
//     agent_ask — Phase 6c

import { agentAsk } from './ask.ts';
import { spawnSubagent, spawnSubagents } from './spawn.ts';
import { subagentList, subagentResult, subagentStatus } from './status.ts';
import type { ToolDefinition } from '../types.ts';

export { agentAsk } from './ask.ts';
export { configureSpawnTools, spawnSubagent, spawnSubagents } from './spawn.ts';
export { subagentList, subagentResult, subagentStatus } from './status.ts';

export function agentTools(): ToolDefinition[] {
  return [
    spawnSubagent,
    spawnSubagents,
    subagentStatus,
    subagentResult,
    subagentList,
    agentAsk,
  ] as ToolDefinition[];
}
