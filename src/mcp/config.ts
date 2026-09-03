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

/** codex-cli variant of the proxy entry — `-c` TOML flags, mirroring
 *  somoraMemoryCodexFlags. `toolTimeoutSec` should cover the per-server
 *  tools/call budget plus forward round-trip. */
export function somoraMcpProxyCodexFlags(args: {
  server: string;
  agent: string;
  toolTimeoutSec: number;
}): string[] {
  const useLocalTsx = existsSync(TSX_BIN_REPO);
  const command = useLocalTsx ? TSX_BIN_REPO : 'npx';
  const cmdArgs = useLocalTsx ? [MCP_SERVER_TS] : ['tsx', MCP_SERVER_TS];
  const argsToml = `[${cmdArgs.map(tomlString).join(', ')}]`;
  const name = somoraMcpProxyName(args.server);

  const envMap = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envMap.set(k, v);
  }
  envMap.set('SOMORA_AGENT', args.agent);
  envMap.set('SOMORA_MCP_PROXY_SERVER', args.server);
  const envToml = `{ ${[...envMap].map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`;

  return [
    '-c',
    `mcp_servers.${name}.command=${tomlString(command)}`,
    '-c',
    `mcp_servers.${name}.args=${argsToml}`,
    '-c',
    `mcp_servers.${name}.env=${envToml}`,
    '-c',
    `mcp_servers.${name}.default_tools_approval_mode="approve"`,
    '-c',
    `mcp_servers.${name}.tool_timeout_sec=${args.toolTimeoutSec}`,
  ];
}

/**
 * codex-cli takes runtime config via `-c key=value` flags, where value
 * is parsed as TOML. Build the trio of flags that registers the
 * somora MCP server for one `codex exec` invocation.
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
  /** Active model for this turn — see somoraMemoryServerSpawn. */
  activeModelRef?: string;
  /**
   * Per-MCP-tool-call timeout in seconds. Maps to codex's
   * `mcp_servers.<name>.tool_timeout_sec` config key. Codex's hidden
   * default is 60s — too short for sub-spawns and long-blocking tools
   * (subagent_result with wait_until_done). Pass through from
   * config.codexCli.toolTimeoutSec.
   */
  toolTimeoutSec?: number;
}): string[] {
  const useLocalTsx = existsSync(TSX_BIN_REPO);
  const command = useLocalTsx ? TSX_BIN_REPO : 'npx';
  const cmdArgs = useLocalTsx ? [MCP_SERVER_TS] : ['tsx', MCP_SERVER_TS];
  const argsToml = `[${cmdArgs.map(tomlString).join(', ')}]`;

  // Forward the full parent process.env into the MCP child so skill-
  // backed tools (gog, etc.) inside the somora exec path see
  // GOG_KEYRING_PASSWORD, GOG_ACCOUNT and any other credentials loaded
  // from ~/.config/systemd/user/somora.env or ~/.somora/somora.env at
  // server start. This mirrors claude-cli's somoraMemoryServerSpawn()
  // which simply does `...filterEnv(process.env)`. Without this the
  // codex-cli MCP child got only the SOMORA_* subset and skills that
  // depend on env-injected secrets silently broke for codex-driven
  // agents (lisa) but worked for claude-driven agents (naxon) —
  // exactly the 2026-05-10 gog/lisa regression.
  //
  // The somora-specific keys are appended LAST so they override the
  // inherited values (e.g. SOMORA_AGENT is forced to this agent even
  // if the parent process had a different value).
  const envMap = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    // codex parses the env TOML inline-table; keep keys to plain
    // identifier-like ones to avoid TOML escaping edge cases (env vars
    // shouldn't contain dots/brackets anyway, but be defensive).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envMap.set(k, v);
  }
  envMap.set('SOMORA_AGENT', args.agent);
  if (args.session) envMap.set('SOMORA_SESSION', args.session);
  if (args.subagentDepth !== undefined && args.subagentDepth > 0) {
    envMap.set('SOMORA_SUBAGENT_DEPTH', String(args.subagentDepth));
  }
  if (args.activeModelRef) envMap.set('SOMORA_ACTIVE_MODEL', args.activeModelRef);

  const envEntries: string[] = [];
  for (const [k, v] of envMap) {
    envEntries.push(`${k} = ${tomlString(v)}`);
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
    // and auto-cancels with "user cancelled MCP tool call". The somora
    // server is OUR server with OUR allowlisted tool surface, no need for
    // user approval per-call. Equivalent to claude-cli's canUseTool gate
    // returning {behavior:'allow'} for `mcp__somora__*`.
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
    ...resolveToolTimeoutFlag(args.toolTimeoutSec),
    ...resolveShellEnvPolicyFlag(),
  ];
}

/**
 * Resolve codex's `shell_environment_policy.inherit` setting. With
 * codex's default ('core'), only PATH/HOME/USER/LANG and a small core
 * set survive into shells spawned by the codex `exec` tool — agents
 * lose access to the somora-server env (GOG_KEYRING_PASSWORD,
 * GOG_ACCOUNT, custom skill credentials). With 'all', the parent env
 * is inherited.
 *
 * Reads SOMORA_CODEX_SHELL_ENV_POLICY (set by applyCodexCliEnv from
 * config.codexCli.shellEnvironmentPolicy). Default behavior here, in
 * the absence of env, is to emit the 'all' flag — the somora server
 * is already a trusted process and the env is the canonical place for
 * skill secrets.
 */
function resolveShellEnvPolicyFlag(): string[] {
  const raw = process.env.SOMORA_CODEX_SHELL_ENV_POLICY;
  // 'core-only' → codex default; emit nothing so codex's built-in default
  // applies (less surface area).
  if (raw === 'core-only') return [];
  // 'inherit-all' or unset → emit the inherit=all flag.
  return ['-c', 'shell_environment_policy.inherit="all"'];
}

/**
 * Resolve the codex tool_timeout_sec flag. Precedence:
 * 1. Explicit `args.toolTimeoutSec` from the caller (rare — mostly
 *    reserved for tests / programmatic overrides).
 * 2. `SOMORA_CODEX_TOOL_TIMEOUT_SEC` env, set by applyCodexCliEnv() at
 *    server boot from `config.codexCli.toolTimeoutSec`.
 * 3. Skip the flag entirely → codex uses its built-in default (60s).
 */
function resolveToolTimeoutFlag(explicit: number | undefined): string[] {
  if (explicit !== undefined) {
    return ['-c', `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${explicit}`];
  }
  const fromEnv = process.env.SOMORA_CODEX_TOOL_TIMEOUT_SEC;
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) {
      return ['-c', `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${n}`];
    }
  }
  return [];
}

function tomlString(s: string): string {
  // TOML basic strings escape backslashes and double-quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
