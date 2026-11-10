// somora's login key (private/auth-key/KONZEPT.md).
//
// One key per installation, in `~/.somora/server.key` (0600):
// `somora_` + 32 random bytes as base64url. With `server.auth: on` (the
// default) every request needs it — programs send
// `Authorization: Bearer <key>` (or `X-Somora-Key`), browsers carry a
// cookie they got from `POST /auth/login`. Programs on the same machine
// read the file themselves; child processes get it as `SOMORA_KEY`.
//
// This module holds both halves: what a client needs to send the key,
// and what the server needs to check it. No server imports here, so the
// TUI, the MCP child and the CLI can use it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_PREFIX = 'somora_';
export const KEY_PATTERN = /^somora_[A-Za-z0-9_-]{43}$/;
export const COOKIE_NAME = 'somora_key';
export const KEY_ENV = 'SOMORA_KEY';

export function keyFilePath(home = process.env.SOMORA_HOME ?? join(homedir(), '.somora')): string {
  return join(home, 'server.key');
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

/** The key in the file, or null when there is none (or it is garbled). */
export function readKeyFile(path = keyFilePath()): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return KEY_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Write `key` atomically with owner-only rights. */
export function writeKeyFile(key: string, path = keyFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The key, made on first use. Also tightens the file's rights. */
export function ensureKeyFile(path = keyFilePath()): { key: string; created: boolean } {
  const existing = readKeyFile(path);
  if (existing) {
    try {
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    } catch {
      /* rights are the owner's business if we cannot change them */
    }
    return { key: existing, created: false };
  }
  const key = generateKey();
  writeKeyFile(key, path);
  return { key, created: true };
}

// ── client side ──────────────────────────────────────────────────────

/** The key a client on this machine sends: `SOMORA_KEY`, else the file. */
export function clientKey(): string | null {
  const fromEnv = process.env[KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return readKeyFile();
}

/** `headers` with the key added, unless the caller set one already.
 *  A plain object, so it works with any fetch implementation. */
export function withKeyHeader(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(new Headers(headers).entries());
  if (!('authorization' in out) && !('x-somora-key' in out)) {
    const key = clientKey();
    if (key) out.authorization = `Bearer ${key}`;
  }
  return out;
}

// ── server side ──────────────────────────────────────────────────────

/** What a browser's cookie holds: derived from the key, so a new key
 *  (`somora key rotate`) signs every browser out. */
export function cookieToken(key: string): string {
  return createHmac('sha256', key).update('somora-browser-v1').digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Presented =
  | { kind: 'none' }
  | { kind: 'key'; value: string }
  | { kind: 'cookie'; value: string };

/** Where a request carries the key, if anywhere. */
export function presentedKey(headers: { authorization?: string; xKey?: string; cookie?: string }): Presented {
  const auth = headers.authorization?.trim();
  if (auth && /^bearer\s+/i.test(auth)) return { kind: 'key', value: auth.replace(/^bearer\s+/i, '').trim() };
  const x = headers.xKey?.trim();
  if (x) return { kind: 'key', value: x };
  const cookie = headers.cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE_NAME}=`));
  if (cookie) {
    // A malformed escape (`somora_key=%`) is a wrong key (401), not a
    // crash (500) (Fable review Nr. 28).
    let value: string;
    try {
      value = decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
    } catch {
      value = '';
    }
    return { kind: 'cookie', value };
  }
  return { kind: 'none' };
}

/** The server's copy of the key: read from the file, and read again
 *  when the file changes (`somora key rotate` needs no restart). */
export class KeyStore {
  private key: string;
  private cookie: string;
  private mtimeMs = 0;
  private checkedAt = 0;
  private readonly path: string;

  constructor(path = keyFilePath()) {
    this.path = path;
    const { key } = ensureKeyFile(path);
    this.key = key;
    this.cookie = cookieToken(key);
    this.mtimeMs = this.fileMtime();
  }

  private fileMtime(): number {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }

  current(): string {
    const now = Date.now();
    if (now - this.checkedAt > 2_000) {
      this.checkedAt = now;
      const m = this.fileMtime();
      if (m !== this.mtimeMs) {
        this.mtimeMs = m;
        // A deleted or garbled file gets a fresh key rather than none.
        const key = readKeyFile(this.path) ?? ensureKeyFile(this.path).key;
        if (key !== this.key) {
          this.key = key;
          this.cookie = cookieToken(key);
        }
        this.mtimeMs = this.fileMtime();
      }
    }
    return this.key;
  }

  cookieValue(): string {
    this.current();
    return this.cookie;
  }

  /** Does the presented value open the door? */
  accepts(p: Presented): boolean {
    if (p.kind === 'key') return sameText(p.value, this.current());
    if (p.kind === 'cookie') return sameText(p.value, this.cookieValue());
    return false;
  }
}

/** Wrong keys per address: after `max` misses in `windowMs` the address
 *  waits `blockMs`. A request without any key is not a miss — an old
 *  browser tab polling away must not lock its owner out. */
export class MissCounter {
  private misses = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly blockMs: number;

  constructor(max = 10, windowMs = 5 * 60_000, blockMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
  }

  blocked(ip: string, now = Date.now()): boolean {
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return false;
    if (now < until) return true;
    this.blockedUntil.delete(ip);
    return false;
  }

  miss(ip: string, now = Date.now()): void {
    const recent = (this.misses.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    if (recent.length >= this.max) {
      this.blockedUntil.set(ip, now + this.blockMs);
      this.misses.delete(ip);
    } else {
      this.misses.set(ip, recent);
    }
  }
}
