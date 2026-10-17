import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from './yaml.ts';
import { assertUniqueAliases, type Config, ConfigSchema } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const CONFIG_PATH = join(SOMORA_HOME, 'config.yaml');

const DEFAULT_CONFIG = `# somora server config — lives at ~/.somora/config.yaml
# \`somora setup\` is the guided way to fill it (models, agents, memory, HTTPS).
# API keys are stored here as plain text. This file is *not* committed
# (it lives outside the repo). Use config.example.yaml in the repo as a
# documentation reference.
#
# Provider names ('anthropic', 'omlx' below) are free-form keys —
# pick what's memorable for you. 'ollama', 'lmstudio', 'home-gpu',
# 'pi-edge' all work.
#
# Per-model 'alias' lets you reference a model by short nickname anywhere
# (agent.yaml, /model in the clients). Aliases must be unique across the
# whole config.

server:
  port: 18737

providers:
  # Anthropic via a Claude subscription. Runs the Claude Code that ships
  # with somora (or your own), so no baseUrl / apiKey needed.
  # capabilities: 'text' (always), 'image' (vision input), 'reasoning'
  # (model exposes a thinking/reasoning effort knob — controllable via
  # /thinking and persona thinking: …).
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-5-5
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
      # - id: claude-sonnet-5-5
      #   alias: sonnet
      #   contextWindow: 1000000
      #   capabilities: [text, image, pdf, reasoning]
      # - id: claude-haiku-5-5
      #   alias: haiku
      #   contextWindow: 1000000
      #   capabilities: [text, image, pdf, reasoning]

  # Example: local OpenAI-compatible server (Ollama / LM Studio / oMLX / vLLM).
  # Uncomment and adjust to wire it up. Rename the key to whatever fits.
  #
  # omlx:
  #   engine: openai-compatible
  #   baseUrl: http://localhost:11434/v1
  #   apiKey: lm-studio
  #   models:
  #     - id: gemma-4-31b-it-8bit
  #       alias: gemma4big
  #       contextWindow: 131072
  #       capabilities: [text, image]
  #     - id: gemma-4-26b-a4b-it-4bit
  #       alias: gemma4small
  #       contextWindow: 131072
  #       capabilities: [text, image]

# Compaction: when a conversation nears the model's context window,
# older turns are summarized. Works without this block; the values
# below are the defaults. SOMORA_COMPACTION_* environment variables
# override them.
# compaction:
#   triggerRatio: 0.8          # compact at 80% of the model's context window
#   safetyCushionPairs: 4      # the newest N user/assistant pairs stay as they are
#   modelOverride: opus        # a fixed model for the summary (alias or provider/id)

# The tool loop of OpenAI-compatible models (the CLI engines run their
# own loop).
# agentLoop:
#   maxRounds: 8               # model rounds per turn (1..100)
#   maxToolCallsPerTurn: 30    # tool calls per turn, across all rounds
#   toolCallTimeoutMs: 30000   # time limit of one tool call, in ms

# Memory: works with the defaults below; add the block only to tune.
# memory:
#   embedding:
#     provider: local                      # runs on this machine (@huggingface/transformers)
#     model: all-MiniLM-L6-v2              # alias or a full Hugging Face repo path
#                                          # known-good aliases:
#                                          #   all-MiniLM-L6-v2 (default, 384 dim, ~30 MB)
#                                          #   all-mpnet-base-v2 (768 dim, ~110 MB, better quality)
#                                          #   paraphrase-multilingual-MiniLM-L12-v2 (384 dim, multilingual)
#   chunking:
#     targetTokens: 400                    # target size of a chunk (about 4 characters a token)
#     overlapTokens: 80                    # overlap between chunks
#   autoInject:
#     queryTurns: 3                        # recent turns that form the search query
#     maxResults: 5                        # hits added to a turn
#     minScore: 0.35                       # hits below this score are dropped (0..1)
#     maxTokens: 1500                      # size limit of the memory block
#   hybrid:
#     vectorWeight: 0.7                    # weight of vector similarity in the fused score
#     bm25Weight: 0.3                      # weight of BM25 (keyword) score
#     slugMatchBoost: 1.5                  # page whose name contains a query word (1 = off)
#     slugFullNameBoost: 1.5               # extra when the query names the page in full (1 = off)
#     logDemotion: 0.5                     # wiki change logs rank behind the pages (1 = off)
#     pageSupport: 0.3                     # a page matching in several sections gains support (0 = off)

# Workspace: the default folder of the file tools. Not a sandbox: what
# an agent may not touch is set by the file rules (docs/security.md).
# An agent can have its own in agent.yaml (workspace.path). ~ is your
# home folder; the folder is made at start.
# workspace:
#   default: ~/somoraworkspace

# Resources: named SSH machines. The file and shell tools take an
# optional target, local by default or one of these names. keyPath is
# the private key on this machine; hostKey (sha256:...) pins the host
# key instead of trusting it on first use.
# resources:
#   linuxserver-1:
#     type: ssh
#     host: 192.0.2.10
#     user: alice
#     keyPath: ~/.ssh/id_ed25519
#     description: |
#       Build box in the lab. Ubuntu 24.04, Docker installed.
#     workspace: /home/alice/work
#     # hostKey: 'sha256:abc...'      # optional; without it, trust on first use

# Web tools: a tool whose provider has no key is hidden from agents.
# Brave: 2,000 requests a month on the free tier,
# https://api-dashboard.search.brave.com/.
# web:
#   brave:
#     apiKey: "BSAxxx..."

# What the terminal client shows. Display only: memory and tools run
# the same either way. Change it while chatting with /show <topic>
# on|off and /verbose <topic> on|off.
#
# show.*    — whether the line appears at all
# verbose.* — how much it shows when it does:
#               tools  → full input and output under each tool call
#               memory → the full injected text under each [memory · …]
#               system → prints the system prompt once
# tui:
#   show:
#     memory: true
#     tools: true
#   verbose:
#     tools: false
#     memory: false
#     system: false
`;

/** One schema problem: the dotted path and what is wrong. */
export interface ConfigIssue {
  path: string;
  message: string;
}

/** Validate config.yaml text exactly as the server does at start and on
 *  reload: YAML syntax, the schema, unique model aliases. Never throws. */
export function validateConfigText(raw: string): { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, issues: [{ path: '(yaml)', message: (err as Error).message.split('\n')[0] ?? String(err) }] };
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })) };
  }
  try {
    assertUniqueAliases(result.data);
  } catch (err) {
    return { ok: false, issues: [{ path: 'providers', message: (err as Error).message }] };
  }
  return { ok: true, config: result.data };
}

export function formatConfigIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
}

export async function loadConfig(): Promise<Config> {
  await mkdir(SOMORA_HOME, { recursive: true });
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFile(CONFIG_PATH, DEFAULT_CONFIG, 'utf8');
    raw = DEFAULT_CONFIG;
  }
  const checked = validateConfigText(raw);
  if (!checked.ok) {
    throw new Error(`config.yaml is invalid (${CONFIG_PATH}):\n${formatConfigIssues(checked.issues)}`);
  }
  return checked.config;
}

// Lazy hot-reload cache for config.yaml. Tools that legitimately need
// edit-then-immediately-use semantics (resource_list / resource_test —
// the agent edits config.yaml to add a new SSH target and tests it on
// the next turn) call getFreshConfig() which stats the file, compares
// against the cached mtime, and re-loads only when it actually changed.
//
// Why not a chokidar watcher: lazy is simpler — no watcher lifecycle,
// no race against running connections. Stat is cheap (one syscall),
// re-parse only fires when the file genuinely changed since last call.
//
// Why not just always re-load: parsing YAML + zod-validating on every
// tool call is more wasteful than a stat. Plus per-Provider cache
// invalidation gets messy if we end up holding ResolvedModel pointers
// elsewhere (currently we don't, but the cache makes that safe).
//
// Note: this does NOT re-apply applyClaudeCliSdkEnv / applyCodexCliEnv
// — env vars are set once at boot. If you change claudeCli/codexCli
// settings in config.yaml at runtime, restart the server. Resources
// are the only block today that's safe to hot-reload because they're
// pure data (no env-var side effects).
let cachedFreshConfig: Config | null = null;
let cachedFreshMtimeMs = 0;

/** The file on disk does not validate; the last valid config stays in
 *  use. `since` = when this version of the file was first seen. */
export interface ConfigProblem {
  mtimeMs: number;
  since: string;
  message: string;
}
let configProblem: ConfigProblem | null = null;

/** Set while config.yaml on disk is invalid and the last valid version
 *  is in use; null once the file validates again. */
export function currentConfigProblem(): ConfigProblem | null {
  return configProblem;
}

/** After POST /config/reload: make getFreshConfig() hand out the same
 *  object the server just switched to, instead of re-parsing once more. */
export function primeFreshConfig(cfg: Config, mtimeMs: number): void {
  cachedFreshConfig = cfg;
  cachedFreshMtimeMs = mtimeMs;
  configProblem = null;
}

export async function getFreshConfig(): Promise<Config> {
  let mtimeMs = 0;
  try {
    const st = await stat(CONFIG_PATH);
    mtimeMs = st.mtimeMs;
  } catch {
    // File missing — fall through to loadConfig which writes the
    // default and returns it (preserves the existing behavior).
  }
  if (cachedFreshConfig && mtimeMs === cachedFreshMtimeMs) {
    return cachedFreshConfig;
  }
  let fresh: Config;
  try {
    fresh = await loadConfig();
  } catch (err) {
    // A broken edit must not stop every turn of every agent: keep the
    // last valid config, as POST /config/reload does, and say so once
    // per version of the file. Without a last valid one (nothing loaded
    // yet) there is nothing to fall back to.
    if (!cachedFreshConfig) throw err;
    if (configProblem?.mtimeMs !== mtimeMs) {
      configProblem = { mtimeMs, since: new Date().toISOString(), message: (err as Error).message };
      // Imported here, not at the top: the CLI loads this module too and
      // must not start the server's log writer.
      const { logger } = await import('../server/logger.ts');
      logger.error({ msg: 'config.invalid_kept_last_good', err: (err as Error).message });
    }
    cachedFreshMtimeMs = mtimeMs;
    return cachedFreshConfig;
  }
  if (configProblem) {
    const { logger } = await import('../server/logger.ts');
    logger.info({ msg: 'config.valid_again' });
  }
  configProblem = null;
  cachedFreshConfig = fresh;
  cachedFreshMtimeMs = mtimeMs;
  return fresh;
}

export function configPath(): string {
  return CONFIG_PATH;
}

/**
 * Push claude-cli-relevant tunables from config into process.env so the
 * claude-agent-sdk subprocess inherits them. Explicit env wins (override
 * layer per the project's config-vs-env policy) — only set when unset.
 *
 * Call once at server boot, before the first claude-cli engine call.
 */
export function applyClaudeCliSdkEnv(config: Config): void {
  const c = config.claudeCli;
  if (process.env.MCP_TOOL_TIMEOUT === undefined || process.env.MCP_TOOL_TIMEOUT === '') {
    process.env.MCP_TOOL_TIMEOUT = String(c.mcpToolTimeoutMs);
  }
  if (process.env.MCP_TIMEOUT === undefined || process.env.MCP_TIMEOUT === '') {
    process.env.MCP_TIMEOUT = String(c.mcpConnectTimeoutMs);
  }
}

/**
 * Push codex-cli-relevant tunables from config into process.env. Used as
 * an internal bridge — the codex-cli engine reads
 * SOMORA_CODEX_TOOL_TIMEOUT_SEC and emits the matching `-c
 * mcp_servers.somora.tool_timeout_sec=N` flag for each codex exec
 * invocation. Mirrors applyClaudeCliSdkEnv()'s policy: explicit env wins.
 */
export function applyCodexCliEnv(config: Config): void {
  const c = config.codexCli;
  if (
    process.env.SOMORA_CODEX_TOOL_TIMEOUT_SEC === undefined ||
    process.env.SOMORA_CODEX_TOOL_TIMEOUT_SEC === ''
  ) {
    process.env.SOMORA_CODEX_TOOL_TIMEOUT_SEC = String(c.toolTimeoutSec);
  }
  // shellEnvironmentPolicy is consumed by the codex-cli engine via
  // SOMORA_CODEX_SHELL_ENV_POLICY → `-c shell_environment_policy.inherit=…`.
  // Default 'inherit-all' makes codex's exec-shells see the full somora
  // server env (GOG_KEYRING_PASSWORD etc.) — fixes the 2026-05-10
  // bea/gog regression where codex's default core-only env stripping
  // hid skill-required vars from the agent's shell.
  if (
    process.env.SOMORA_CODEX_SHELL_ENV_POLICY === undefined ||
    process.env.SOMORA_CODEX_SHELL_ENV_POLICY === ''
  ) {
    process.env.SOMORA_CODEX_SHELL_ENV_POLICY = c.shellEnvironmentPolicy;
  }
  // Read by the codex-cli engine when it builds the dynamic tool catalog
  // (deferLoading per tool). Always mirrors config — no operator env knob.
  process.env.SOMORA_CODEX_DIRECT_TOOLS = JSON.stringify(c.directTools);
}
