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
 * to the given agent + session + sub-depth. SOMORA_AGENT scopes memory
 * tools, SOMORA_SESSION lets spawn_subagent record parent_session for
 * traceability, and SOMORA_SUBAGENT_DEPTH enforces the recursion cap
 * when a sub itself tries to spawn further subs.
 */
export function somoraMemoryServerSpawn(args: {
  agent: string;
  session?: string;
  subagentDepth?: number;
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
      // SOMORA_HOST/PORT are inherited via filterEnv (the parent server
      // process has them), so spawn_subagent's HTTP-fallback can find
      // the localhost endpoint. Belt-and-suspenders explicit:
      ...(process.env.SOMORA_HOST ? { SOMORA_HOST: process.env.SOMORA_HOST } : {}),
      ...(process.env.SOMORA_PORT ? { SOMORA_PORT: process.env.SOMORA_PORT } : {}),
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
 * codex-cli takes runtime config via `-c key=value` flags, where value
 * is parsed as TOML. Build the trio of flags that registers the
 * somora-memory MCP server for one `codex exec` invocation.
 *
 * codex inherits its own env into MCP children, so we override only
 * the somora-specific bits: SOMORA_AGENT (memory scoping),
 * SOMORA_SESSION (parent_session for spawn meta), SOMORA_SUBAGENT_DEPTH
 * (recursion cap).
 */
export function somoraMemoryCodexFlags(args: {
  agent: string;
  session?: string;
  subagentDepth?: number;
}): string[] {
  const useLocalTsx = existsSync(TSX_BIN_REPO);
  const command = useLocalTsx ? TSX_BIN_REPO : 'npx';
  const cmdArgs = useLocalTsx ? [MCP_SERVER_TS] : ['tsx', MCP_SERVER_TS];
  const argsToml = `[${cmdArgs.map(tomlString).join(', ')}]`;

  const envEntries: string[] = [`SOMORA_AGENT = ${tomlString(args.agent)}`];
  if (process.env.SOMORA_HOME) {
    envEntries.push(`SOMORA_HOME = ${tomlString(process.env.SOMORA_HOME)}`);
  }
  if (process.env.SOMORA_HOST) {
    envEntries.push(`SOMORA_HOST = ${tomlString(process.env.SOMORA_HOST)}`);
  }
  if (process.env.SOMORA_PORT) {
    envEntries.push(`SOMORA_PORT = ${tomlString(process.env.SOMORA_PORT)}`);
  }
  if (args.session) {
    envEntries.push(`SOMORA_SESSION = ${tomlString(args.session)}`);
  }
  if (args.subagentDepth !== undefined && args.subagentDepth > 0) {
    envEntries.push(`SOMORA_SUBAGENT_DEPTH = ${tomlString(String(args.subagentDepth))}`);
  }
  const envToml = `{ ${envEntries.join(', ')} }`;

  return [
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(command)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${argsToml}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env=${envToml}`,
    // Auto-approve our tools — codex's default ("auto") still routes through
    // the approval flow, which in `codex exec` (non-interactive) hits no UI
    // and auto-cancels with "user cancelled MCP tool call". The somora-memory
    // server is OUR server with OUR allowlisted tool surface, no need for
    // user approval per-call. Equivalent to claude-cli's canUseTool gate
    // returning {behavior:'allow'} for `mcp__somora-memory__*`.
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}

function tomlString(s: string): string {
  // TOML basic strings escape backslashes and double-quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
