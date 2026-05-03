import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
# pick what's memorable for you. 'ollama', 'lmstudio', 'naxxen-cloud',
# 'pi-im-keller' all work.
#
# Per-model 'alias' lets you reference a model by short nickname anywhere
# (in persona frontmatter, later via /model in the CLI). Aliases must be
# globally unique across the whole config.

server:
  port: 18737

providers:
  # Anthropic via Claude Code subscription. Uses the local Claude Code
  # binary (~/.local/bin/claude), so no baseUrl / apiKey needed.
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-4-7
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image]
      # - id: claude-sonnet-4-6
      #   alias: sonnet
      #   contextWindow: 200000
      #   capabilities: [text, image]
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

# TUI-Anzeige-Defaults für die Ink-CLI. Beeinflusst nur das Rendering,
# nicht die tatsächliche Memory-Injection oder Tool-Ausführung — die
# laufen unverändert auf dem Server. Zur Laufzeit umstellbar via
# /show memory on|off bzw. /show tools on|off.
# tui:
#   show:
#     memory: true                         # Memory-Inject-Block im Chat anzeigen
#     tools: true                          # Tool-Call/Result/Error-Zeilen anzeigen
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
    throw new Error(`config.yaml ist ungültig (${CONFIG_PATH}):\n${issues}`);
  }
  assertUniqueAliases(result.data);
  return result.data;
}

export function configPath(): string {
  return CONFIG_PATH;
}
