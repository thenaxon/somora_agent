// Credential providers for the MCP hub (design §4.8). A provider yields
// the auth headers a server connection needs, resolved fresh at connect
// time. Two kinds today:
//
//   - static: config `headers` with `${VAR}` env expansion (Phase 1).
//   - oauth-refresh: read an access token from a login-written JSON file
//     (e.g. `/design-login`'s `designOauth`), refresh it against the
//     token endpoint when it nears expiry, and write the rotated token
//     back. Cross-process safe via a lockfile so two agent turns don't
//     both refresh (and clobber each other's rotated refresh_token).
//
// The credential file is NEVER config — it's operator-provisioned by an
// interactive login. The hub only reads/refreshes it.

import { existsSync } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpOAuthRefresh, McpServerConfig } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { expandEnvString } from './env-expand.ts';

export interface CredentialProvider {
  /** Auth + static headers for a connection, resolved fresh (refreshing
   *  an OAuth token if it's near expiry). Throws on unrecoverable auth
   *  failure (missing file/key, refresh rejected). */
  resolveHeaders(): Promise<Record<string, string>>;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Static headers with env expansion — the Phase 1 behavior. */
export class StaticHeaderProvider implements CredentialProvider {
  constructor(private headers: Record<string, string>) {}
  resolveHeaders(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers)) {
      out[k.toLowerCase()] = expandEnvString(v);
    }
    return Promise.resolve(out);
  }
}

interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  scopes?: string[];
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 100;

/**
 * OAuth-login credential with self-refresh. Reads `credentialKey` from
 * `credentialFile`, hands out `Authorization: Bearer <token>` merged
 * with the server's static headers. Refreshes when the token is within
 * REFRESH_SKEW_MS of expiry.
 */
export class OAuthRefreshProvider implements CredentialProvider {
  private file: string;
  private lockPath: string;

  constructor(
    private auth: McpOAuthRefresh,
    private staticHeaders: Record<string, string>,
  ) {
    this.file = expandHome(
      auth.credentialFile ?? join(homedir(), '.somora', 'claude-home', '.credentials.json'),
    );
    this.lockPath = `${this.file}.${auth.credentialKey}.refresh.lock`;
  }

  async resolveHeaders(): Promise<Record<string, string>> {
    let cred = await this.read();
    const now = Date.now();
    if (cred.expiresAt !== undefined && cred.expiresAt - now < REFRESH_SKEW_MS) {
      cred = await this.refreshLocked(cred);
    }
    const out: Record<string, string> = { authorization: `Bearer ${cred.accessToken}` };
    for (const [k, v] of Object.entries(this.staticHeaders)) {
      // Static headers win only if they're not the auth header.
      if (k.toLowerCase() !== 'authorization') out[k.toLowerCase()] = expandEnvString(v);
    }
    return out;
  }

  private async read(): Promise<OAuthCredential> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      throw new Error(
        `MCP oauth credential file not found: ${this.file} — run the service's interactive login first`,
      );
    }
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const entry = doc[this.auth.credentialKey] as OAuthCredential | undefined;
    if (!entry?.accessToken) {
      throw new Error(
        `MCP oauth credential key "${this.auth.credentialKey}" missing/empty in ${this.file} — run the interactive login`,
      );
    }
    return entry;
  }

  /** Refresh under a cross-process lockfile. If another process already
   *  refreshed (fresh token on re-read after acquiring the lock), use
   *  that instead of a second network round-trip. */
  private async refreshLocked(stale: OAuthCredential): Promise<OAuthCredential> {
    const release = await this.acquireLock();
    try {
      // Re-read: another holder may have refreshed while we waited.
      const current = await this.read();
      if (current.expiresAt !== undefined && current.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
        return current;
      }
      return await this.doRefresh(current.refreshToken ? current : stale);
    } finally {
      await release();
    }
  }

  private async doRefresh(cred: OAuthCredential): Promise<OAuthCredential> {
    if (!cred.refreshToken) {
      throw new Error(`MCP oauth key "${this.auth.credentialKey}" has no refresh_token — re-login required`);
    }
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      ...(cred.clientId ? { client_id: cred.clientId } : {}),
    });
    const res = await fetch(this.auth.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      const status = res.status;
      throw new Error(
        `MCP oauth refresh failed (HTTP ${status}) for "${this.auth.credentialKey}"${
          status === 400 || status === 401 ? ' — refresh token expired/revoked, re-login required' : ''
        }`,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!data.access_token) {
      throw new Error(`MCP oauth refresh returned no access_token for "${this.auth.credentialKey}"`);
    }
    const updated: OAuthCredential = {
      accessToken: data.access_token,
      // Server rotates the refresh_token — persisting the new one is
      // mandatory, the old one is invalidated after this call.
      refreshToken: data.refresh_token ?? cred.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : cred.expiresAt,
      ...(cred.clientId ? { clientId: cred.clientId } : {}),
      scopes: data.scope ? data.scope.split(' ') : cred.scopes,
    };
    await this.writeBack(updated);
    logger.info({
      msg: 'mcp.hub.oauth_refreshed',
      key: this.auth.credentialKey,
      expiresInSec: data.expires_in,
    });
    return updated;
  }

  /** Merge the refreshed credential back into the file, preserving every
   *  other top-level key (claudeAiOauth etc.). Atomic tmp+rename. */
  private async writeBack(updated: OAuthCredential): Promise<void> {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      // File vanished — recreate with just this key.
    }
    doc[this.auth.credentialKey] = updated;
    const tmp = `${this.file}.hubtmp.${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fh = await open(this.lockPath, 'wx');
        await fh.close();
        return async () => {
          try {
            await rename(this.lockPath, `${this.lockPath}.done`);
            await (await import('node:fs/promises')).unlink(`${this.lockPath}.done`).catch(() => {});
          } catch {
            /* best effort */
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (Date.now() > deadline) {
          // Stale lock: reclaim and proceed (best effort).
          logger.warn({ msg: 'mcp.hub.oauth_lock_stale', key: this.auth.credentialKey });
          try {
            await (await import('node:fs/promises')).unlink(this.lockPath);
          } catch {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }
}

/** Preset expander: fills url/auth/headers for known services so the
 *  operator only writes `preset: claude-design`. Explicit config fields
 *  always override the preset. */
export function applyMcpPreset(name: string, cfg: McpServerConfig): McpServerConfig {
  if (cfg.preset === 'claude-design') {
    return {
      ...cfg,
      url: cfg.url ?? 'https://api.anthropic.com/v1/design/mcp',
      auth:
        cfg.auth ??
        ({
          type: 'oauth-refresh',
          credentialKey: 'designOauth',
          tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
        } as McpOAuthRefresh),
      headers: {
        'X-Anthropic-Client': 'claude-cli-design-tool',
        ...cfg.headers,
      },
    };
  }
  return cfg;
}

export function buildCredentialProvider(cfg: McpServerConfig): CredentialProvider {
  if (cfg.auth?.type === 'oauth-refresh') {
    return new OAuthRefreshProvider(cfg.auth, cfg.headers);
  }
  return new StaticHeaderProvider(cfg.headers);
}

export function assertHasUrl(name: string, cfg: McpServerConfig): string {
  if (!cfg.url) {
    throw new Error(`MCP server "${name}" has no url and no preset that supplies one`);
  }
  return cfg.url;
}
