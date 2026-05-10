// Loads ~/.somora/somora.env into process.env at server start so
// per-host secrets (GOG_KEYRING_PASSWORD, GOG_ACCOUNT, etc.) and
// agent-shared config are available to MCP child processes regardless
// of how somora was launched (manual `tsx`, systemd-user-unit, tmux,
// macOS LaunchAgent, …).
//
// Why this exists: each somora agent has its own server process. If
// agent `lisa` is launched without the env vars naxon happens to have
// in her shell, skill calls (gog, etc.) break for lisa even though
// everything works for naxon — exactly the symptom in the
// 2026-05-10 gog-env-inheritance bug report.
//
// Centralizing the env source under ~/.somora makes the per-agent
// situation deterministic: drop secrets in one file, every agent's
// server process picks them up the same way.
//
// Format: KEY=value, one per line. Comments start with `#`. Values
// may be wrapped in single or double quotes. NOT a full dotenv parser
// (no interpolation, no multiline values) — keep this file small.
//
// Precedence: existing process.env wins. The file is a default
// provider, not an override. Matches the project's "config-and-file
// give defaults, explicit env wins" policy (feedback_config_over_env).

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const DEFAULT_ENV_FILE = process.env.SOMORA_ENV_FILE ?? join(SOMORA_HOME, 'somora.env');

export interface LoadEnvFileResult {
  path: string;
  exists: boolean;
  loaded: number;
  skipped: number;
  permissionWarning?: string;
}

export function loadSomoraEnvFile(path: string = DEFAULT_ENV_FILE): LoadEnvFileResult {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { path, exists: false, loaded: 0, skipped: 0 };
  }
  if (!stat.isFile()) {
    return { path, exists: false, loaded: 0, skipped: 0 };
  }

  // Permission check: env files hold secrets. If group/world readable,
  // emit a warning string — caller decides whether to log it.
  const mode = stat.mode & 0o777;
  let permissionWarning: string | undefined;
  if (mode & 0o077) {
    permissionWarning =
      `env file is group/world-readable (mode=${mode.toString(8).padStart(3, '0')}); ` +
      `recommend \`chmod 600 ${path}\` since it contains secrets`;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { path, exists: true, loaded: 0, skipped: 0, ...(permissionWarning ? { permissionWarning } : {}) };
  }

  let loaded = 0;
  let skipped = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip a single layer of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] !== undefined) {
      skipped += 1;
      continue;
    }
    process.env[key] = value;
    loaded += 1;
  }

  return {
    path,
    exists: true,
    loaded,
    skipped,
    ...(permissionWarning ? { permissionWarning } : {}),
  };
}
