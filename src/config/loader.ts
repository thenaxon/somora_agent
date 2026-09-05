import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { assertUniqueAliases, type Config, ConfigSchema } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const CONFIG_PATH = join(SOMORA_HOME, 'config.yaml');

const DEFAULT_CONFIG = `# somora server config — lives at ~/.somora/config.yaml
# API keys are stored here as plain text. This file is *not* committed
# (it lives outside the repo). Use config.example.yaml in the repo as a
# documentation reference.
#
# Provider names ('anthropic', 'omlx' below) are free-form keys —
# pick what's memorable for you. 'ollama', 'lmstudio', 'home-gpu',
# 'pi-edge' all work.
#
# Per-model 'alias' lets you reference a model by short nickname anywhere
# (in persona frontmatter, later via /model in the CLI). Aliases must be
# globally unique across the whole config.

server:
  port: 18737

providers:
  # Anthropic via Claude Code subscription. Uses the local Claude Code
  # binary (~/.local/bin/claude), so no baseUrl / apiKey needed.
  # capabilities: 'text' (always), 'image' (vision input), 'reasoning'
  # (model exposes a thinking/reasoning effort knob — controllable via
  # /thinking and persona thinking: …).
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-4-7
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image, reasoning]
      # - id: claude-sonnet-4-6
      #   alias: sonnet
      #   contextWindow: 200000
      #   capabilities: [text, image, reasoning]
      # - id: claude-haiku-4-5
      #   alias: haiku
      #   contextWindow: 200000
      #   capabilities: [text, image]

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

# Compaction-Tunables (DECISION #21). Greifen automatisch — wenn der
# Block fehlt, gelten die unten kommentierten Default-Werte.
# SOMORA_COMPACTION_* env vars überschreiben diese hier zur Laufzeit.
# compaction:
#   triggerRatio: 0.8          # Compaction ab 80% des aktuellen Modell-Windows
#   safetyCushionPairs: 4      # die N jüngsten user/assistant-Pairs bleiben unkomprimiert
#   modelOverride: opus        # festes Worker-Modell für Summarisation (alias oder provider/id)

# Agent-Loop-Tunables (Phase 2-Stufe-C). Greifen nur bei openai-compatible —
# claude-cli und codex-cli haben eigene interne Loops.
# agentLoop:
#   maxRounds: 8               # max Tool-Call-Rounds pro Turn (1..100)
#   toolCallTimeoutMs: 30000   # per-Tool-Call Timeout in ms

# Memory-Layer-Tunables (DECISIONS #25-#27). Greifen automatisch mit
# Default-Werten — Block hier nur wenn du tunen willst. Pro-Agent-
# Overrides können später in agent.yaml leben.
# memory:
#   embedding:
#     provider: local                      # 'local' (@huggingface/transformers) — andere later
#     model: all-MiniLM-L6-v2              # alias oder voller HF-Repo-Pfad
#                                          # known-good aliases:
#                                          #   all-MiniLM-L6-v2 (default, 384 dim, ~30MB)
#                                          #   all-mpnet-base-v2 (768 dim, ~110MB, höhere Qualität)
#                                          #   paraphrase-multilingual-MiniLM-L12-v2 (384 dim, multiling.)
#   chunking:
#     targetTokens: 400                    # Soll-Größe pro Chunk (Heuristik 4 chars/token)
#     overlapTokens: 80                    # Überlappung zwischen Chunks
#   autoInject:
#     queryTurns: 3                        # wieviele letzte Turns als Embedding-Query
#     maxResults: 5                        # Top-N Treffer pro Turn injecten
#     minScore: 0.5                        # Treffer unter diesem Score verwerfen (0..1)
#     maxTokens: 1500                      # Hard-Cap auf den injecten Memory-Block
#   hybrid:
#     vectorWeight: 0.7                    # Gewichtung Vector-Score in Hybrid-Fusion
#     bm25Weight: 0.3                      # Gewichtung BM25/FTS5-Score

# Workspace — Default-CWD für die file_*-Tools. Kein Sandkasten:
# Agents dürfen auch außerhalb schreiben (eigene Persona-Files,
# globale config). Schutz kommt aus einer Path-Blacklist in den Tools
# selbst, nicht aus dieser Konfig. Per-Agent-Override in agent.yaml
# unter workspace.path. ~ wird zu $HOME expandiert. Wird beim
# Server-Start auto-angelegt.
# workspace:
#   default: ~/somoraworkspace

# Resources — benannte SSH-Targets. file_* und exec-Tools nehmen einen
# optionalen target-Parameter; default local, alternativ einer
# dieser Namen. keyPath ist der Pfad zum Private-Key auf dem somora-
# Server selbst. hostKey (sha256:...) erzwingt strict-mode statt TOFU.
# resources:
#   linuxserver-1:
#     type: ssh
#     host: 192.0.2.10
#     user: alice
#     keyPath: ~/.ssh/id_ed25519
#     description: |
#       Bastion in der Werkstatt. Ubuntu 24.04, Docker installed.
#     workspace: /home/alice/work
#     # hostKey: 'sha256:abc...'      # optional, sonst TOFU

# Web-Tools-Credentials. Pro-Provider-Schlüssel — Tools deren Provider
# nicht konfiguriert ist sind für den Agent unsichtbar (available()
# Probe filtert sie raus). Brave: 2k Anfragen/Monat im Free-Tier,
# https://api-dashboard.search.brave.com/.
# web:
#   brave:
#     apiKey: "BSAxxx..."

# TUI-Anzeige-Defaults für die Ink-CLI. Beeinflusst nur das Rendering,
# nicht die tatsächliche Memory-Injection oder Tool-Ausführung — die
# laufen unverändert auf dem Server. Zur Laufzeit umstellbar via
# /show <topic> on|off bzw. /verbose <topic> on|off.
#
# show.*    — line visibility (off = die Zeile erscheint gar nicht)
# verbose.* — Detailtiefe wenn die Zeile DOCH erscheint:
#               tools  → volles Input/Output unter jedem Tool-Call
#               memory → voller Inject-Text unter jedem [memory · …]
#               system → /verbose system on druckt System-Prompt einmalig
# tui:
#   show:
#     memory: true
#     tools: true
#   verbose:
#     tools: false
#     memory: false
#     system: false
`;

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
  const parsed = parseYaml(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config.yaml is invalid (${CONFIG_PATH}):\n${issues}`);
  }
  assertUniqueAliases(result.data);
  return result.data;
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

/** After POST /config/reload: make getFreshConfig() hand out the same
 *  object the server just switched to, instead of re-parsing once more. */
export function primeFreshConfig(cfg: Config, mtimeMs: number): void {
  cachedFreshConfig = cfg;
  cachedFreshMtimeMs = mtimeMs;
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
  const fresh = await loadConfig();
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
  // lisa/gog regression where codex's default core-only env stripping
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
