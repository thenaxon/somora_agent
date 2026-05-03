// SSH connection pool — one cached Client per resource name. Lazy
// open on first use, idle-closed after IDLE_TIMEOUT_MS, keepalive
// pings every 30s to detect broken connections quickly.
//
// Auth: private key file only (no passwords, no agent forwarding —
// see docs/research/tool-architecture.md and the user's stated
// security posture). The keyfile is loaded once at first connect and
// kept in process memory for the pool's lifetime.
//
// All file_* and exec tools that target a remote resource go through
// here. Single chokepoint = single place for logging, lifecycle,
// host-key verification, and (later) connection-level metrics.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshResource } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { verifyHostKey } from './known-hosts.ts';

const READY_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

interface PooledConnection {
  client: Client;
  resourceName: string;
  resource: SshResource;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  /** Resolves when the underlying client emits 'ready'. */
  readyP: Promise<Client>;
  /** Set when the connection has emitted 'error' or 'close'. */
  closed: boolean;
}

const pool = new Map<string, PooledConnection>();

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

async function loadKey(keyPath: string): Promise<Buffer> {
  const expanded = expandHome(keyPath);
  return readFile(expanded);
}

/**
 * Acquire a ready ssh2 Client for a named resource. Reuses pooled
 * connection if alive, opens a new one otherwise. Refreshes the
 * idle timer on every call.
 */
export async function getConnection(
  resourceName: string,
  resource: SshResource,
): Promise<Client> {
  const existing = pool.get(resourceName);
  if (existing && !existing.closed) {
    bumpIdle(existing);
    return existing.readyP;
  }

  const client = new Client();
  let resolveReady!: (c: Client) => void;
  let rejectReady!: (err: Error) => void;
  const readyP = new Promise<Client>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const entry: PooledConnection = {
    client,
    resourceName,
    resource,
    lastUsedAt: Date.now(),
    idleTimer: null,
    readyP,
    closed: false,
  };
  pool.set(resourceName, entry);

  client.on('ready', () => {
    bumpIdle(entry);
    logger.info({
      msg: 'ssh.connect.ready',
      resource: resourceName,
      host: resource.host,
      port: resource.port,
      user: resource.user,
    });
    resolveReady(client);
  });
  client.on('error', (err) => {
    entry.closed = true;
    logger.warn({
      msg: 'ssh.connect.error',
      resource: resourceName,
      err: err.message,
    });
    rejectReady(err);
  });
  client.on('close', () => {
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    pool.delete(resourceName);
    logger.info({ msg: 'ssh.connect.closed', resource: resourceName });
  });

  // Host-key verifier per ssh2's hostVerifier callback. Returns boolean
  // synchronously; we resolve TOFU/strict beforehand.
  let keyBlob: Buffer;
  try {
    keyBlob = await loadKey(resource.keyPath);
  } catch (err) {
    entry.closed = true;
    pool.delete(resourceName);
    throw new Error(
      `ssh: cannot read keyfile '${resource.keyPath}' for resource '${resourceName}': ${(err as Error).message}`,
    );
  }

  const cfg: ConnectConfig = {
    host: resource.host,
    port: resource.port,
    username: resource.user,
    privateKey: keyBlob,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: 3,
    // ssh2 hostVerifier callback: sync, must return a boolean during
    // the handshake. We resolve TOFU/strict synchronously (known_hosts
    // is loaded sync from a small file) so the pin write happens BEFORE
    // we accept. On mismatch we log and return false; ssh2 then aborts
    // the handshake and emits 'error', which rejects readyP.
    hostVerifier: (hostKey: Buffer | string): boolean => {
      const buf = typeof hostKey === 'string' ? Buffer.from(hostKey, 'hex') : hostKey;
      const result = verifyHostKey({
        resourceName,
        hostKeyBuf: buf,
        expected: resource.hostKey,
      });
      if (!result.ok) {
        logger.warn({
          msg: 'ssh.host_key.refused',
          resource: resourceName,
          reason: result.reason,
        });
      }
      return result.ok;
    },
  };

  client.connect(cfg);
  return readyP;
}

function bumpIdle(entry: PooledConnection): void {
  entry.lastUsedAt = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.closed) return;
    logger.info({ msg: 'ssh.idle_close', resource: entry.resourceName });
    try {
      entry.client.end();
    } catch {
      /* best-effort */
    }
  }, IDLE_TIMEOUT_MS);
}

/**
 * Close every pooled connection. Server-shutdown hook.
 */
export async function shutdownSshPool(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  for (const e of entries) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    try {
      e.client.end();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Diagnostic snapshot — used by resource_test and ops/healthz later.
 */
export function poolSnapshot(): Array<{
  resource: string;
  ready: boolean;
  idleMs: number;
}> {
  const now = Date.now();
  const out: Array<{ resource: string; ready: boolean; idleMs: number }> = [];
  for (const [name, entry] of pool.entries()) {
    out.push({
      resource: name,
      ready: !entry.closed,
      idleMs: now - entry.lastUsedAt,
    });
  }
  return out;
}
