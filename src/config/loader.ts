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
  #   baseUrl: http://192.168.60.47:11434/v1
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
