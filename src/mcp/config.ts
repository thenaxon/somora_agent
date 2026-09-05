// Shared helper for engine adapters that need to spawn the somora
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

/** MCP-server name as it appears in claude-cli/codex-cli configs.
 *  Renamed from `somora-memory` (v2026.09.03.05): the server carries
 *  every somora tool, not only memory. External-server proxy children
 *  register as `somora-<name>` and stay distinct. CLI sessions recorded
 *  under the old name are restarted once — see the `mcpServerName`
 *  resume guard in each CLI adapter. */
export const MCP_SERVER_NAME = 'somora';

/** Tool-name prefix in the LLM's view: `mcp__somora__memory_search` etc. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Build the stdio-spawn config for the somora MCP server, scoped
 * to the given agent + session + sub-depth. SOMORA_AGENT scopes memory
 * tools, SOMORA_SESSION lets spawn_subagent record parent_session for
 * traceability, and SOMORA_SUBAGENT_DEPTH enforces the recursion cap
 * when a sub itself tries to spawn further subs.
 */
export function somoraMemoryServerSpawn(args: {
  agent: string;
  session?: string;
  subagentDepth?: number;
  /** Active model for this turn as `<provider>/<modelId>`. The MCP
   *  child surfaces this via ToolContext.activeModel so capability-
   *  gated tools (file_read polymorph) can decide whether to return
   *  multimodal content blocks. */
  activeModelRef?: string;
}): {
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
      SOMORA_AGENT: args.agent,
      ...(args.session ? { SOMORA_SESSION: args.session } : {}),
      ...(args.subagentDepth !== undefined && args.subagentDepth > 0
        ? { SOMORA_SUBAGENT_DEPTH: String(args.subagentDepth) }
        : {}),
      ...(args.activeModelRef ? { SOMORA_ACTIVE_MODEL: args.activeModelRef } : {}),
      // SOMORA_HOST/PORT/TLS are inherited via filterEnv (the parent
      // server process has them), so spawn_subagent's HTTP-fallback can
      // find the endpoint and pick the right scheme. Belt-and-suspenders
      // explicit:
      ...(process.env.SOMORA_HOST ? { SOMORA_HOST: process.env.SOMORA_HOST } : {}),
      ...(process.env.SOMORA_PORT ? { SOMORA_PORT: process.env.SOMORA_PORT } : {}),
      ...(process.env.SOMORA_TLS ? { SOMORA_TLS: process.env.SOMORA_TLS } : {}),
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

/**
 * External-MCP proxy children (design: private/mcp-hub-design.md §4.4).
 * Same binary as somora, switched into proxy mode by the
 * SOMORA_MCP_PROXY_SERVER env var: it then serves ONE upstream server's
 * tools from the catalog snapshot and forwards tools/call via HTTP to
 * the main server's hub (the single real MCP client). CLI-side entry
 * name is `somora-<server>`, so the model sees
 * `mcp__somora-<server>__<tool>`.
 */
export function somoraMcpProxyName(server: string): string {
  return `somora-${server}`;
}

export function somoraMcpProxySpawn(args: {
  server: string;
  agent: string;
}): { command: string; args: string[]; env: Record<string, string> } {
  const useLocalTsx = existsSync(TSX_BIN_REPO);
  return {
    command: useLocalTsx ? TSX_BIN_REPO : 'npx',
    args: useLocalTsx ? [MCP_SERVER_TS] : ['tsx', MCP_SERVER_TS],
    env: {
      // filterEnv carries SOMORA_HOME (catalog path) and SOMORA_HOST/
      // PORT/TLS (HTTP-forward endpoint) from the parent server.
      ...filterEnv(process.env),
      SOMORA_AGENT: args.agent,
      SOMORA_MCP_PROXY_SERVER: args.server,
    },
  };
}

// The `codex exec` flag builders (somoraMemoryCodexFlags,
// somoraMcpProxyCodexFlags) were removed 2026-09-05: the codex-cli engine
// now drives the Codex app-server and hands somora's tools over as dynamic
// tools (src/engine/codex-dynamic-tools.ts), so Codex never spawns this
// MCP server. claude-cli keeps using somoraMemoryServerSpawn above.
