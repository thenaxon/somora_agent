// somora-managed known_hosts. Separate from ~/.ssh/known_hosts on
// purpose — the user's ssh-client and somora's resource pool are
// different trust contexts. somora's file lives at
// $SOMORA_HOME/known_hosts.json and is JSON-keyed by resource name.
//
// TOFU semantics: first successful connection to a named resource
// pins the host's pubkey fingerprint here. Subsequent connections
// require a match. Strict mode (`hostKey` set in config) bypasses
// this file entirely — config is authoritative.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const KNOWN_HOSTS_PATH = join(SOMORA_HOME, 'known_hosts.json');

// In-process cache. Loaded synchronously on first access because the
// ssh2 hostVerifier callback is sync — we have one event-loop tick to
// decide accept/reject. The file is small (one line per resource) so
// sync reads are fine.
let cache: Record<string, string> | null = null;

function loadSync(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw = readFileSync(KNOWN_HOSTS_PATH, 'utf8');
    cache = JSON.parse(raw) as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

function saveSync(): void {
  if (!cache) return;
  try {
    writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ msg: 'ssh.known_hosts.save_failed', err: (err as Error).message });
  }
}

/**
 * Compute a sha256:<base64> fingerprint over a host pubkey blob —
 * matches OpenSSH's `ssh-keygen -lf -E sha256` format.
 */
export function fingerprint(hostKey: Buffer): string {
  const hash = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
  return `sha256:${hash}`;
}

/**
 * Sync host-key decision. `expected` from config (if set) wins;
 * otherwise the pinned fingerprint in known_hosts.json wins; if
 * neither, this is a first connection — pin synchronously and accept.
 *
 * Returns:
 *   - true when the key is acceptable
 *   - false when there's a mismatch (caller should refuse the connection)
 *
 * Sync-only by design: ssh2's hostVerifier callback runs during the
 * handshake and demands a synchronous boolean. The TOFU pin write is
 * also sync (cheap — small file) so the pinning happens before we
 * say "yes" to the SSH library.
 */
export function verifyHostKey(args: {
  resourceName: string;
  hostKeyBuf: Buffer;
  expected?: string;
}): { ok: boolean; reason: string } {
  const fp = fingerprint(args.hostKeyBuf);
  if (args.expected) {
    const ok = constantTimeEqual(fp, args.expected);
    return ok
      ? { ok: true, reason: 'matched config-pinned hostKey' }
      : {
          ok: false,
          reason: `host key mismatch: got ${fp}, config expected ${args.expected}`,
        };
  }
  const known = loadSync();
  const pinned = known[args.resourceName];
  if (!pinned) {
    cache![args.resourceName] = fp;
    saveSync();
    logger.info({ msg: 'ssh.host_key.pinned_tofu', resource: args.resourceName, fingerprint: fp });
    return { ok: true, reason: 'first connection — pinned via TOFU' };
  }
  if (constantTimeEqual(fp, pinned)) {
    return { ok: true, reason: 'matched TOFU-pinned hostKey' };
  }
  return {
    ok: false,
    reason: `host key changed since first connection: pinned ${pinned}, got ${fp}. ` +
      `If this change is legitimate, remove the entry from ${KNOWN_HOSTS_PATH} and reconnect.`,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
