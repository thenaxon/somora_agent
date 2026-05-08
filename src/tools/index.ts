// Top-level tools surface. Server constructs a single ToolRegistry,
// registers all groups, and hands ToolContext to each invocation.

import { ToolRegistry } from './registry.ts';
import { memoryTools } from './memory/index.ts';
import { dreamTools } from './dream/index.ts';
import { timeTools } from './time/index.ts';
import { webTools } from './web/index.ts';
import { somoraDocsTools } from './docs/index.ts';
import { resourceTools } from './resources/index.ts';
import { fileTools } from './file/index.ts';
import { analyzeFileTools } from './file/index.ts';
import { agentTools } from './agents/index.ts';
import { execTools } from './exec/index.ts';
import { tmuxTools } from './tmux/index.ts';
import { skillTools } from './skill/index.ts';

export { ToolRegistry } from './registry.ts';
export type { ToolContext, ToolDefinition, ToolInvoker, ToolResult } from './types.ts';
export { memoryTools } from './memory/index.ts';
export { dreamTools } from './dream/index.ts';
export { timeTools } from './time/index.ts';
export { webTools } from './web/index.ts';
export { somoraDocsTools } from './docs/index.ts';
export { resourceTools } from './resources/index.ts';
export { fileTools, analyzeFileTools } from './file/index.ts';
export { agentTools, configureSpawnTools } from './agents/index.ts';
export {
  configureExecConcurrencyCaps,
  execTools,
  logExecCaps,
  recoverOrphanedJobs,
} from './exec/index.ts';
export { tmuxTools } from './tmux/index.ts';
export { skillTools } from './skill/index.ts';

/**
 * Single source of truth for "every tool somora exposes". Both registration
 * sites — the in-process HTTP/agent-loop registry (`src/server/index.ts`)
 * and the MCP child-process registry (`src/mcp/server.ts`) — call this so
 * the two engine paths can never drift. Adding a new tool bundle: import it
 * above and add ONE `registerMany()` line below; both sites pick it up.
 *
 * The two registries are separate ToolRegistry instances (the MCP server
 * runs in a child process per claude-cli/codex-cli turn — different process,
 * different memory) but they're populated by the same code, so the
 * effective tool set is identical across all three engines.
 *
 * Bug 2026-05-07 (Phase X scaffold): adding `skillTools()` only to the HTTP
 * site left claude-cli blind to the new tool. Dual-registry consolidation
 * is the fix that prevents the class of bug going forward.
 */
export function registerAllTools(registry: ToolRegistry): void {
  registry.registerMany(memoryTools());
  registry.registerMany(dreamTools());
  registry.registerMany(timeTools());
  registry.registerMany(webTools());
  registry.registerMany(somoraDocsTools());
  registry.registerMany(resourceTools());
  registry.registerMany(fileTools());
  registry.registerMany(analyzeFileTools());
  registry.registerMany(agentTools());
  registry.registerMany(execTools());
  registry.registerMany(tmuxTools());
  registry.registerMany(skillTools());
}
