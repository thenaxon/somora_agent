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
  /** True when the token handed out last is about to expire AND this
   *  provider is allowed to rotate it — the hub then reconnects early
   *  so the rotation happens before the upstream starts refusing the
   *  old bearer (a live streamable-http session keeps sending the
   *  token it connected with). Optional: static providers never rotate. */
  refreshDue?(): boolean;
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
    // The lock is per FILE, not per key: two keys in one file are
    // rewritten through the same read-modify-write.
    this.lockPath = `${this.file}.${this.keys()[0]}.refresh.lock`;
  }

  /** Candidate keys, in preference order. */
  private keys(): string[] {
    const k = this.auth.credentialKey;
    return Array.isArray(k) ? k : [k];
  }

  /** Whether this provider owns the refresh chain of the key in use.
   *  `refresh: true` owns every key, a list owns exactly those keys,
   *  `false` owns none. */
  private refreshAllowed(): boolean {
    const r = this.auth.refresh;
    if (typeof r === 'boolean') return r;
    const key = this.usedKey ?? this.keys()[0]!;
    return r.includes(key);
  }

  /** Expiry of the credential handed out last (ms epoch), for the
   *  hub's proactive rotation. Undefined until the first read. */
  private lastExpiresAt: number | undefined;

  refreshDue(): boolean {
    if (!this.refreshAllowed()) return false;
    if (this.lastExpiresAt === undefined) return false;
    return this.lastExpiresAt - Date.now() < REFRESH_SKEW_MS;
  }

  async resolveHeaders(): Promise<Record<string, string>> {
    let cred = await this.read();
    const now = Date.now();
    if (cred.expiresAt !== undefined && cred.expiresAt - now < REFRESH_SKEW_MS) {
      if (this.refreshAllowed()) {
        cred = await this.refreshLocked(cred);
      } else {
        // Read-only credential: another process owns the refresh chain.
        // Use what's on disk; if upstream rejects it the server parks
        // as needs-auth and re-reads the file on the next probe — by
        // then the owner has usually refreshed it.
        logger.debug({
          msg: 'mcp.hub.oauth_near_expiry_readonly',
          key: this.activeKeyLabel(),
          expiresInMs: cred.expiresAt - now,
        });
      }
    }
    this.lastExpiresAt = cred.expiresAt;
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
    // First key that is actually there wins. Presence, not preference
    // on paper: the preferred credential only exists once its login has
    // been run, and falling through to the next one is what lets the
    // same config work before and after that.
    for (const key of this.keys()) {
      const entry = doc[key] as OAuthCredential | undefined;
      if (entry?.accessToken) {
        if (key !== this.usedKey) {
          logger.debug({ msg: 'mcp.hub.oauth_key_selected', key, file: this.file });
          this.usedKey = key;
        }
        return entry;
      }
    }
    const tried = this.keys().join(', ');
    throw new Error(
      `MCP oauth credential key${this.keys().length > 1 ? 's' : ''} "${tried}" missing/empty in ` +
        `${this.file} — run the service's interactive login`,
    );
  }

  /** The key actually in use, or the configured list when nothing has
   *  been read yet — so a message never claims a credential it didn't
   *  touch. */
  private activeKeyLabel(): string {
    return this.usedKey ?? this.keys().join(' | ');
  }

  /** Which key the last read resolved to. Reported in errors so a
   *  rejection can be traced to the credential it used. */
  private usedKey: string | null = null;

  /** The credential this provider is currently speaking with. */
  activeKey(): string | null {
    return this.usedKey;
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
      throw new Error(`MCP oauth key "${this.activeKeyLabel()}" has no refresh_token — re-login required`);
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
      if (status === 400 || status === 401) {
        // The chain is dead: nothing will make this refresh_token work
        // again. Move the entry aside so the interactive login can
        // write a fresh one — Claude Code's `/design-login` refuses with
        // "A design credential is already stored" while the dead key
        // sits in the file, and nobody should have to hand-edit
        // .credentials.json to get out of that (2026-08-31 report).
        const retiredAs = await this.retireCredential();
        throw new Error(
          `MCP oauth refresh rejected (HTTP ${status}) for "${this.activeKeyLabel()}" — refresh token ` +
            `expired/revoked. The stale entry was moved to "${retiredAs}" in ${this.file}; ` +
            `run the service's interactive login again (Claude Design: ` +
            `CLAUDE_CONFIG_DIR=~/.somora/claude-home claude → /design-login), then reconnect the server.`,
        );
      }
      throw new Error(`MCP oauth refresh failed (HTTP ${status}) for "${this.activeKeyLabel()}"`);
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!data.access_token) {
      throw new Error(`MCP oauth refresh returned no access_token for "${this.activeKeyLabel()}"`);
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
      key: this.activeKeyLabel(),
      expiresInSec: data.expires_in,
    });
    return updated;
  }

  /** Merge the refreshed credential back into the file, preserving every
   *  other top-level key (claudeAiOauth etc.). Atomic tmp+rename. */
  private async writeBack(updated: OAuthCredential): Promise<void> {
    await this.rewriteFile((doc) => {
      doc[this.usedKey ?? this.keys()[0]!] = updated;
    });
  }

  /** Rename the dead credential's key to `<key>_stale_<timestamp>` —
   *  kept for forensics, out of the login's way. Returns the new key.
   *  Called under the refresh lock. */
  private async retireCredential(): Promise<string> {
    const key = this.usedKey ?? this.keys()[0]!;
    const retiredAs = `${key}_stale_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await this.rewriteFile((doc) => {
      if (doc[key] !== undefined) {
        doc[retiredAs] = doc[key];
        delete doc[key];
      }
    });
    logger.warn({ msg: 'mcp.hub.oauth_credential_retired', key, retiredAs, file: this.file });
    this.usedKey = null;
    this.lastExpiresAt = undefined;
    return retiredAs;
  }

  private async rewriteFile(mutate: (doc: Record<string, unknown>) => void): Promise<void> {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      // File vanished — recreate with just what mutate() adds.
    }
    mutate(doc);
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
          logger.warn({ msg: 'mcp.hub.oauth_lock_stale', key: this.activeKeyLabel() });
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
      // Which credential authenticates this has now changed twice, so
      // the preset names BOTH and takes whichever exists.
      //
      //   until 2026-08-25  a separate `/design-login` credential
      //                     (`designOauth`) — then that flow broke on
      //                     recent CLI versions
      //   2026-08-25        the ordinary `claudeAiOauth` login worked,
      //                     verified against the live endpoint
      //   2026-08-28        Anthropic split out a `user:design:*` scope.
      //                     The ordinary token does not carry it and the
      //                     endpoint answers 403 `needs_design_scopes`;
      //                     `/design-login` is back and required.
      //                     Measured both ways on the day: designOauth
      //                     → 200 with tools, claudeAiOauth → 403.
      //
      // Listing both rather than flipping the constant means the next
      // move in either direction costs nobody a config edit. `read()`
      // takes the first key present in the file, and `designOauth` only
      // exists once its login has been run.
      //
      // Refresh ownership, per key:
      //   claudeAiOauth  — the CLI's. Two refreshers on one rotating
      //                    chain invalidate each other; that is how a
      //                    Design credential got revoked on 2026-08-25.
      //   designOauth    — somora's, since 2026-08-31. Nothing else
      //                    keeps it alive: the CLI only touches it when
      //                    an interactive session in this config dir
      //                    uses the Design MCP, so with somora as the
      //                    only steady consumer the token simply expired
      //                    every ~8 h and needed a manual /design-login
      //                    (plus a hand-edit to get past "already
      //                    stored"). The refresh runs under the file
      //                    lock with a re-read, and the rotated token is
      //                    written back for the CLI to pick up.
      auth:
        cfg.auth ??
        ({
          type: 'oauth-refresh',
          credentialKey: ['designOauth', 'claudeAiOauth'],
          tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
          refresh: ['designOauth'],
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
