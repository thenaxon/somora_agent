// Work an agent starts to outlive somora — a background job, a tmux
// server — gets a systemd scope of its own when somora runs as a
// systemd service. A service's processes share its cgroup, and a stop
// or restart (KillMode=control-group, the default) ends all of them:
// `detached: true` only makes a new process group, so background jobs
// died with every `somora update` although docs/tools.md promised they
// survive (Fable review 2026-11-10 Nr. 7). `systemd-run --scope` moves
// the started process into a transient scope outside the service; it
// runs the command itself (exec), so the pid and process group stay
// what the caller sees.
//
// Off when somora is not a systemd service (no INVOCATION_ID — a
// terminal, launchd, a container) or `systemd-run --user` does not work
// here; then nothing changes.

import { spawnSync } from 'node:child_process';
import { logger } from '../../server/logger.ts';

let available: boolean | undefined;

/** Whether this process runs under systemd and can start user scopes. */
export function scopesAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (process.platform !== 'linux' || !process.env.INVOCATION_ID) return available;
  try {
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { timeout: 10_000, stdio: 'ignore' });
    available = r.status === 0;
  } catch {
    available = false;
  }
  logger.info({ msg: 'exec.systemd_scope', available });
  return available;
}

/** For tests. */
export function setScopesAvailableForTest(v: boolean | undefined): void {
  available = v;
}

/** A unit name systemd accepts: `somora-<kind>-<name>` with only
 *  [A-Za-z0-9_-], plus a short random tail so two starts never clash. */
export function scopeUnitName(kind: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  return `somora-${kind}-${safe}-${Math.random().toString(36).slice(2, 6)}.scope`;
}

/** argv prefix that runs a command in its own scope, or [] when scopes
 *  are not available. */
export function scopeArgv(unit: string): string[] {
  if (!scopesAvailable()) return [];
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--'];
}
