// Hot reload of config.yaml. The server keeps one parsed Config and
// re-reads it on POST /config/reload (web taskbar gear, TUI /reload)
// instead of a full restart. Most sections are read at request time and
// follow the swap immediately; the ones below are consumed once at boot
// (env vars, child processes, sockets, schedulers) and only take effect
// after a restart — the reload response names them so the client can
// say so.

import type { Config } from './types.ts';

/** Top-level config.yaml sections that only apply after a restart. */
export const RESTART_REQUIRED_SECTIONS: readonly string[] = [
  'server', // host / port / TLS — sockets are bound at boot
  'memory', // embedding model + sqlite handles live in cached managers
  'obsidian', // vault source resolved at boot for the wiki workers
  'wiki', // Deep / Lucid schedulers read enabled + intervals at start()
  'mcp', // hub children are spawned at boot
  'claudeCli', // applied as process env at boot
  'codexCli', // applied as process env at boot
  'stt', // voice backends are wired at boot
  'tts',
  'sentinel', // scheduler + retention read at boot
  'tmux', // attention watcher configured at boot
  'web', // static mounts decided at boot
  'mobile',
];

/** Top-level sections whose serialized value differs between two configs. */
export function diffConfigSections(prev: Config, next: Config): string[] {
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    const a = JSON.stringify((prev as Record<string, unknown>)[key]);
    const b = JSON.stringify((next as Record<string, unknown>)[key]);
    if (a !== b) changed.push(key);
  }
  return changed;
}

/** Subset of `changed` that needs a restart to take effect. */
export function restartRequiredFor(changed: readonly string[]): string[] {
  return changed.filter((k) => RESTART_REQUIRED_SECTIONS.includes(k));
}
