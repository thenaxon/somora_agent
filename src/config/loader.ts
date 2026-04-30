import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { type Config, ConfigSchema } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const CONFIG_PATH = join(SOMORA_HOME, 'config.yaml');

const DEFAULT_CONFIG = `# somora server config — lives at ~/.somora/config.yaml
# API keys are stored here as plain text. This file is *not* committed
# (it lives outside the repo). Use config.example.yaml in the repo as a
# documentation reference.

server:
  port: 18737

providers:
  # Anthropic via Claude Code subscription. Uses the local Claude Code
  # binary (~/.local/bin/claude), so no baseUrl / apiKey needed.
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-4-7
        contextWindow: 200000
        capabilities: [text]

  # Example: local OpenAI-compatible server (Ollama / LM Studio / oMLX / vLLM).
  # Uncomment and adjust to wire it up.
  #
  # omlx:
  #   engine: openai-compatible
  #   baseUrl: http://192.168.60.47:11434/v1
  #   apiKey: lm-studio
  #   models:
  #     - id: gemma-4-31b-it-8bit
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
  return result.data;
}

export function configPath(): string {
  return CONFIG_PATH;
}
