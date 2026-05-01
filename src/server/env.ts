// Effective-env helper. Single point of truth for "what SOMORA_*
// values is the running server actually using". Used by:
//   - the `somora.env` log line emitted at server start, so operators
//     see the live config in their daily JSONL log
//   - the `GET /env` HTTP endpoint, so it's queryable while the
//     server is running without rummaging through /proc
//
// Diagnostic-only: this module does NOT replace the existing inline
// `process.env.SOMORA_*` reads scattered across the codebase. It
// re-implements the same default-resolution logic so it can be
// queried independently. If the rules drift, this file lies — keep
// the defaults here in sync with the real call sites.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface EnvField {
  /** Effective value the server is using. `null` means "not set, no default". */
  value: string | number | null;
  /** True if the default was used (env var was unset or value invalid). */
  isDefault: boolean;
  /** Optional source detail — e.g. "filesystem-fallback" for resolved paths. */
  note?: string;
}

export type EffectiveEnv = Record<string, EnvField>;

function envString(name: string, defaultValue: string): EnvField {
  const raw = process.env[name];
  if (!raw) return { value: defaultValue, isDefault: true };
  return { value: raw, isDefault: false };
}

function envInt(name: string, defaultValue: number): EnvField {
  const raw = process.env[name];
  if (!raw) return { value: defaultValue, isDefault: true };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    return { value: defaultValue, isDefault: true, note: `invalid raw=${raw}, fell back to default` };
  }
  return { value: v, isDefault: false };
}

function envFloat01(name: string, defaultValue: number): EnvField {
  const raw = process.env[name];
  if (!raw) return { value: defaultValue, isDefault: true };
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1) {
    return { value: defaultValue, isDefault: true, note: `invalid raw=${raw}, fell back to default` };
  }
  return { value: v, isDefault: false };
}

function resolveClaudeBin(): EnvField {
  const raw = process.env.SOMORA_CLAUDE_BIN;
  if (raw) return { value: raw, isDefault: false };
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return { value: localBin, isDefault: true, note: 'filesystem-fallback' };
  return { value: null, isDefault: true, note: 'binary not found at default path' };
}

function resolveCodexBin(): EnvField {
  const raw = process.env.SOMORA_CODEX_BIN;
  if (raw) return { value: raw, isDefault: false };
  const npmGlobal = join(homedir(), '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobal)) return { value: npmGlobal, isDefault: true, note: 'filesystem-fallback' };
  return { value: 'codex', isDefault: true, note: 'PATH-fallback (binary not found at npm-global)' };
}

export function getEffectiveEnv(): EffectiveEnv {
  return {
    SOMORA_HOME: envString('SOMORA_HOME', join(homedir(), '.somora')),
    SOMORA_PORT: process.env.SOMORA_PORT
      ? envInt('SOMORA_PORT', 18737)
      : { value: null, isDefault: true, note: 'unset → uses config.yaml server.port' },
    SOMORA_LOG_LEVEL: envString('SOMORA_LOG_LEVEL', 'info'),
    SOMORA_CLAUDE_BIN: resolveClaudeBin(),
    SOMORA_CODEX_BIN: resolveCodexBin(),
    // Compaction env vars are now an _override layer_ on top of config.yaml
    // `compaction:` (DECISION #30). Unset = config-or-default takes over.
    SOMORA_COMPACTION_TRIGGER_RATIO: process.env.SOMORA_COMPACTION_TRIGGER_RATIO
      ? envFloat01('SOMORA_COMPACTION_TRIGGER_RATIO', 0.8)
      : { value: null, isDefault: true, note: 'unset → uses config.yaml compaction.triggerRatio (default 0.8)' },
    SOMORA_COMPACTION_SAFETY_PAIRS: process.env.SOMORA_COMPACTION_SAFETY_PAIRS
      ? envInt('SOMORA_COMPACTION_SAFETY_PAIRS', 4)
      : { value: null, isDefault: true, note: 'unset → uses config.yaml compaction.safetyCushionPairs (default 4)' },
    SOMORA_COMPACTION_MODEL: process.env.SOMORA_COMPACTION_MODEL
      ? { value: process.env.SOMORA_COMPACTION_MODEL, isDefault: false }
      : { value: null, isDefault: true, note: 'unset → uses config.yaml compaction.modelOverride (default auto-pick)' },
  };
}
