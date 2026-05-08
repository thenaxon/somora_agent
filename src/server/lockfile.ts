// Server-instance lockfile under ~/.somora/locks/server.lock.
//
// Enforces single-active-server discipline: when a second process tries
// to start while a live one already holds the lock, the second refuses
// with a clear message. Stale locks (PID gone) are reclaimed silently.
//
// Lock content (JSON):
//   { pid, port, host, startedAt, version }
//
// See DECISIONS #42 for the discipline.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SOMORA_HOME_DIR } from './logger.ts';

export const LOCKFILE_PATH = join(SOMORA_HOME_DIR, 'locks', 'server.lock');

export type LockfileContent = {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  version: string;
};

export class LockfileBusy extends Error {
  readonly existing: LockfileContent;
  constructor(existing: LockfileContent) {
    super(
      `somora already running (pid=${existing.pid}, port=${existing.port}, started=${existing.startedAt}). ` +
        `Stop it first: \`somora server stop\` or \`systemctl --user stop somora\`.`,
    );
    this.name = 'LockfileBusy';
    this.existing = existing;
  }
}

export function readLockfile(): LockfileContent | null {
  try {
    const raw = readFileSync(LOCKFILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as LockfileContent;
    if (typeof parsed.pid === 'number') return parsed;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

export function acquireLockfile(content: Omit<LockfileContent, 'pid' | 'startedAt'>): LockfileContent {
  mkdirSync(dirname(LOCKFILE_PATH), { recursive: true });

  const existing = readLockfile();
  if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    throw new LockfileBusy(existing);
  }

  const lock: LockfileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...content,
  };
  writeFileSync(LOCKFILE_PATH, JSON.stringify(lock, null, 2));
  return lock;
}

export function releaseLockfile(): void {
  try {
    const existing = readLockfile();
    if (existing && existing.pid !== process.pid) return;
    unlinkSync(LOCKFILE_PATH);
  } catch {
    // ignore — lockfile already gone is fine
  }
}
