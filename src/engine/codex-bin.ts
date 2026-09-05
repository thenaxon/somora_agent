// Resolves the Codex binary somora runs. Codex is a pinned, bundled
// dependency (`@openai/codex`, exact version in package.json) — a Codex
// release must never change somora's behaviour underneath us; we bump the
// pin deliberately and re-test (design: private/codex-app-server-design.md
// §2). The npm wrapper `bin/codex.js` picks the platform package, so we
// run it through the current node binary.
//
// `SOMORA_CODEX_BIN` remains as an explicit debugging override only.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CodexLaunch {
  command: string;
  args: string[];
  /** 'bundled' or 'override' (SOMORA_CODEX_BIN). */
  source: 'bundled' | 'override';
  version: string | null;
}

let cached: CodexLaunch | undefined;

export function resolveCodexLaunch(): CodexLaunch {
  if (cached) return cached;
  const override = process.env.SOMORA_CODEX_BIN;
  if (override) {
    cached = { command: override, args: [], source: 'override', version: null };
    return cached;
  }
  const require = createRequire(import.meta.url);
  const wrapper = require.resolve('@openai/codex/bin/codex.js');
  let version: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(wrapper), '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    version = pkg.version ?? null;
  } catch {
    version = null;
  }
  cached = { command: process.execPath, args: [wrapper], source: 'bundled', version };
  return cached;
}

/** argv for `codex app-server --listen stdio://` plus config overrides. */
export function codexAppServerArgv(launch: CodexLaunch, extra: string[] = []): string[] {
  return [...launch.args, 'app-server', '--listen', 'stdio://', ...extra];
}
