// Shared helper for engine adapters that need to spawn the somora-memory
// MCP server as a child process. Both claude-cli and codex-cli adapters
// import this so the spawn config is consistent (path, env, name).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../src/mcp -> .../src -> .../somora
const REPO_ROOT = join(__dirname, '..', '..');

const TSX_BIN_REPO = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const MCP_SERVER_TS = join(REPO_ROOT, 'src', 'mcp', 'server.ts');

/** MCP-server name as it appears in claude-cli/codex-cli configs. */
export const MCP_SERVER_NAME = 'somora-memory';

/** Tool-name prefix in the LLM's view: `mcp__somora-memory__memory_search` etc. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Build the stdio-spawn config for the somora-memory MCP server, scoped
 * to the given agent. The agent name flows as SOMORA_AGENT env so the
 * child knows which agent's MemoryManager to construct.
 */
export function somoraMemoryServerSpawn(agent: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  // Prefer the locally-installed tsx binary so we don't depend on what's
  // on PATH for the spawned process. Falls back to npx if missing.
  const useLocalTsx = existsSync(TSX_BIN_REPO);
  return {
    command: useLocalTsx ? TSX_BIN_REPO : 'npx',
    args: useLocalTsx ? [MCP_SERVER_TS] : ['tsx', MCP_SERVER_TS],
    env: {
      ...filterEnv(process.env),
      SOMORA_AGENT: agent,
    },
  };
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  // Forward only string-valued vars (TS env can have undefineds).
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
