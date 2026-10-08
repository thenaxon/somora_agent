// Provider blocks the setup assistant writes. They mirror the tested
// blocks in docs/models.md — presets.test.mts fails when an id here is
// not in that document, so the two cannot drift apart silently.

export interface ModelPreset {
  id: string;
  alias: string;
  contextWindow: number;
  capabilities: string[];
  /** One line for the picker. */
  note: string;
  reasoning?: { levels: Record<string, string> };
}

export interface ProviderPreset {
  /** Key under `providers:`. */
  key: string;
  engine: 'claude-cli' | 'codex-cli' | 'grok-cli' | 'openai-compatible';
  baseUrl?: string;
  models: ModelPreset[];
}

const FULL = ['text', 'image', 'pdf', 'reasoning'];

export const CLAUDE_PRESET: ProviderPreset = {
  key: 'anthropic',
  engine: 'claude-cli',
  models: [
    { id: 'claude-fable-5-1', alias: 'fable', contextWindow: 1000000, capabilities: FULL, note: 'frontier model' },
    { id: 'claude-opus-5-5', alias: 'opus', contextWindow: 1000000, capabilities: FULL, note: 'recommended for most work' },
    { id: 'claude-sonnet-5', alias: 'sonnet', contextWindow: 1000000, capabilities: FULL, note: 'lighter on the subscription budget' },
    { id: 'claude-haiku-4-5', alias: 'haiku', contextWindow: 200000, capabilities: FULL, note: 'fast and cheap — good for background work' },
  ],
};

export const CODEX_PRESET: ProviderPreset = {
  key: 'openai',
  engine: 'codex-cli',
  models: [
    { id: 'gpt-6-astra', alias: 'astra', contextWindow: 258400, capabilities: FULL, note: 'frontier model', reasoning: { levels: { off: 'low', high: 'xhigh' } } },
    { id: 'gpt-5.6-sol', alias: 'gpt56', contextWindow: 258400, capabilities: FULL, note: 'strong all-rounder', reasoning: { levels: { high: 'xhigh' } } },
    { id: 'gpt-5.6-terra', alias: 'terra', contextWindow: 258400, capabilities: FULL, note: 'balanced' },
    { id: 'gpt-5.6-luna', alias: 'luna', contextWindow: 258400, capabilities: FULL, note: 'fast and cheap — good for background work' },
    { id: 'gpt-5.5', alias: 'gpt55', contextWindow: 258400, capabilities: FULL, note: 'previous generation' },
  ],
};

export const GROK_PRESET: ProviderPreset = {
  key: 'xai',
  engine: 'grok-cli',
  models: [
    { id: 'grok-4.7', alias: 'grok', contextWindow: 256000, capabilities: ['text', 'reasoning'], note: 'frontier model' },
  ],
};

/** Default picks per job, in order of preference — the first alias that
 *  is configured wins. Chat wants the best model, the dream workers a
 *  cheap one (REM) or a careful one (Deep, Lucid). */
export const PREFERRED = {
  chat: ['opus', 'fable', 'gpt56', 'astra', 'sonnet', 'terra', 'grok'],
  rem: ['haiku', 'luna', 'sonnet', 'terra'],
  deep: ['opus', 'gpt56', 'sonnet', 'terra', 'fable', 'astra'],
} as const;

export function pickPreferred(job: keyof typeof PREFERRED, aliases: string[]): string | undefined {
  return PREFERRED[job].find((a) => aliases.includes(a)) ?? aliases[0];
}

/** `qwen3:32b-instruct` → `qwen3-32b-instruct` — a nickname that is safe
 *  as an alias and unique among `taken`. */
export function aliasFor(modelId: string, taken: string[]): string {
  const base = (modelId.split('/').pop() ?? modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'model';
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}
