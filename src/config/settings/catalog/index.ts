// What the settings window says about each setting (docs/web.md
// "Settings window"): a name, one plain sentence, an optional longer
// explanation, whether it belongs to the everyday settings or to the
// advanced ones, and whether its value is a secret. One entry per path
// of settings/fields.ts; `*` stands for an entry name.
//
// The idea follows OpenClaw's config hints (a label, help and tier per
// path, from which its control UI builds its forms, with a test that
// every path has its tier). The texts are English, short and plain:
// the window is meant for people who do not read the code. Defaults,
// limits and "needs a restart" are not written here — they come from
// the schema and from RESTART_REQUIRED_SECTIONS, so they cannot drift.

import { AGENTS } from './agents.ts';
import { AUTOMATION } from './automation.ts';
import { ENGINES } from './engines.ts';
import { GENERAL } from './general.ts';
import { IMAGES } from './images.ts';
import { INTERFACES } from './interfaces.ts';
import { MEMORY } from './memory.ts';
import { MODELS } from './models.ts';
import { TOOLS_A } from './tools-a.ts';
import { TOOLS_B } from './tools-b.ts';
import { VOICE } from './voice.ts';

export interface CatalogEntry {
  /** A name in sentence case, without the key: "Results per message". */
  label: string;
  /** One sentence, what it does for the person — not how it is coded. */
  help: string;
  /** Optional: when to change it, what to watch, an example. */
  more?: string;
  /** basic = shown at once; advanced = behind "Show advanced options". */
  level: 'basic' | 'advanced';
  /** The value is a key or password: never sent to the browser. */
  sensitive?: boolean;
  /** Shown beside a number: "s", "min", "tokens", "notes". */
  unit?: string;
  /** docs page and anchor: "memory.md#automatic-recall". */
  docs?: string;
  placeholder?: string;
  /** Shown but not changed in the window, with this reason: a change
   *  that needs more than writing the value (the embedding model needs
   *  the memory index built anew). */
  locked?: string;
  /** No longer read: hidden unless config.yaml still sets it, and then
   *  it can only be removed. somora warns about it at start. */
  retired?: true;
  /** The value names something configured elsewhere: the window offers
   *  those names, and Apply refuses a change that leaves a name pointing
   *  nowhere. Set from SETTING_REFS below, not per catalog file. */
  ref?: RefKind;
}

/** What a reference names: a chat model (alias or provider/id), a
 *  provider, an image or video model by its short name, a decision model. */
export type RefKind = 'model' | 'provider' | 'image-model' | 'video-model' | 'decision-model';

/** Settings whose value names a model or provider configured elsewhere. */
export const SETTING_REFS: Readonly<Record<string, RefKind>> = {
  'compaction.modelOverride': 'model',
  'compaction.workers': 'model',
  'rem.model': 'model',
  'rem.fallback': 'model',
  'rem.dedup.judge.model': 'model',
  'vision.worker': 'model',
  'vision.pdfWorker': 'model',
  'wiki.deep.model': 'model',
  'wiki.deep.fallback': 'model',
  'wiki.lucid.model': 'model',
  'wiki.lucid.fallback': 'model',
  'stt.provider': 'provider',
  'tts.provider': 'provider',
  'imageGen.models.*.provider': 'provider',
  'imageGen.models.*.fallback': 'image-model',
  'videoGen.models.*.provider': 'provider',
  'videoGen.models.*.fallback': 'video-model',
  'decisions.model': 'decision-model',
};

export type Catalog = Record<string, CatalogEntry>;

export interface SettingsGroup {
  id: string;
  title: string;
  /** A lucide icon name. */
  icon: string;
  /** Top-level sections of config.yaml, in the order they are shown. */
  sections: string[];
  /** Fully described and editable. A group that is not ready shows its
   *  values read only, with "change this in config.yaml for now". */
  ready: boolean;
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'general', title: 'General', icon: 'Settings', sections: ['server', 'updateCheck', 'workspace', 'attachments', 'projects'], ready: true },
  { id: 'models', title: 'Models & providers', icon: 'Sparkles', sections: ['providers', 'fallback', 'thinkingContent', 'decisions'], ready: true },
  { id: 'agents', title: 'Agents & turns', icon: 'Bot', sections: ['agentLoop', 'subagents', 'compaction', 'promptBudgets', 'engineWatchdog', 'toolCatalog'], ready: true },
  { id: 'engines', title: 'Engines & coding', icon: 'Cpu', sections: ['claudeCli', 'codexCli', 'tmux', 'lsp'], ready: true },
  { id: 'memory', title: 'Memory & wiki', icon: 'Brain', sections: ['memory', 'rem', 'wiki', 'obsidian'], ready: true },
  { id: 'voice', title: 'Voice', icon: 'Mic', sections: ['stt', 'tts', 'realtimeVoice'], ready: true },
  { id: 'images', title: 'Images & video', icon: 'Image', sections: ['vision', 'imageGen', 'videoGen'], ready: true },
  { id: 'tools', title: 'Tools & connections', icon: 'Wrench', sections: ['browser', 'mcp', 'skills', 'resources', 'external', 'a2a'], ready: true },
  { id: 'automation', title: 'Automation', icon: 'AlarmClock', sections: ['sentinel'], ready: true },
  { id: 'interfaces', title: 'Interfaces', icon: 'Monitor', sections: ['web', 'mobile', 'tui', 'sse'], ready: true },
];

const TEXTS: Catalog = {
  ...GENERAL,
  ...MEMORY,
  ...VOICE,
  ...IMAGES,
  ...AUTOMATION,
  ...INTERFACES,
  ...AGENTS,
  ...ENGINES,
  ...TOOLS_A,
  ...TOOLS_B,
  ...MODELS,
};

export const SETTINGS_CATALOG: Catalog = Object.fromEntries(
  Object.entries(TEXTS).map(([path, entry]) => [path, SETTING_REFS[path] ? { ...entry, ref: SETTING_REFS[path] } : entry]),
);

/** The group a top-level section belongs to. */
export function groupOfSection(section: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((g) => g.sections.includes(section));
}
