// Moved unchanged from src/server/index.ts, which calls registerAuthRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import { isA2APublicPath } from '../../a2a/server.ts';
import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { COOKIE_NAME, MissCounter, presentedKey } from '../auth-key.ts';
import { isThisMachine } from '../browser-guard.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { remoteOf } from '../sse-liveness.ts';
import type { Context } from 'hono';

export interface AuthRoutesDeps {
  keyStore: typeof Server.keyStore;
}

export function registerAuthRoutes(app: Hono, routeDeps: AuthRoutesDeps): void {
  const { keyStore } = routeDeps;
  const keyMisses = new MissCounter();
  const refusedLogged = new Map<string, number>();

  /** Reachable without the key: nothing that shows data. The web and
   *  mobile app shells must load to show the key page. */
  function openWithoutKey(method: string, path: string): boolean {
    if (path === '/healthz' || path === '/auth/status' || path === '/auth/login' || path === '/auth/logout') return true;
    // A2A (docs/a2a.md): the Agent Cards are public by the standard; the
    // JSON-RPC endpoint checks the peers' own tokens, never the login key.
    if (isA2APublicPath(method, path)) return true;
    if (method !== 'GET' && method !== 'HEAD') return false;
    return path === '/web' || path.startsWith('/web/') || path === '/mobile' || path.startsWith('/mobile/');
  }

  const KEY_REFUSAL =
    'somora needs its key. Programs: send "Authorization: Bearer <key>"; on the server "somora key" prints it ' +
    '(a script: -H "Authorization: Bearer $(somora key)"). ' +
    'Browsers: open the link from "somora key link". ' +
    'To switch this off: server.auth: off in config.yaml.';

  app.use('*', async (c, next) => {
    const key = keyStore.current();
    if (process.env.SOMORA_KEY !== key) process.env.SOMORA_KEY = key;
    if (config.server.auth === 'off' || openWithoutKey(c.req.method, c.req.path)) return next();
    const ip = remoteOf(c)?.ip ?? 'unknown';
    // The brake on guessing spares this machine: a program here can read
    // the key file anyway, and a stale key in one agent's script must not
    // lock out every tool call for a minute.
    const local = isThisMachine(ip);
    if (!local && keyMisses.blocked(ip)) {
      return c.json({ error: 'too many wrong keys from this address — wait a minute', kind: 'auth' }, 429);
    }
    const presented = presentedKey({
      authorization: c.req.header('authorization'),
      xKey: c.req.header('x-somora-key'),
      cookie: c.req.header('cookie'),
    });
    if (keyStore.accepts(presented)) return next();
    if (presented.kind !== 'none' && !local) keyMisses.miss(ip);
    // One line per address and path a minute: an old tab polling away
    // must not fill the log.
    const logKey = `${ip} ${c.req.path}`;
    const now = Date.now();
    if (now - (refusedLogged.get(logKey) ?? 0) > 60_000) {
      refusedLogged.set(logKey, now);
      if (refusedLogged.size > 2000) refusedLogged.clear();
      logger.warn({ msg: 'auth.refused', ip, method: c.req.method, path: c.req.path, presented: presented.kind });
    }
    return c.json({ error: KEY_REFUSAL, kind: 'auth' }, 401);
  });

  function keyCookie(c: Context, value: string, maxAgeSeconds: number): string {
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
    return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  }

  // Is the key switched on, and does this browser carry it?
  app.get('/auth/status', (c) => {
    const presented = presentedKey({
      authorization: c.req.header('authorization'),
      xKey: c.req.header('x-somora-key'),
      cookie: c.req.header('cookie'),
    });
    return c.json({ auth: config.server.auth, signedIn: config.server.auth === 'off' || keyStore.accepts(presented) });
  });

  // A browser signs in with the key once and gets a cookie (a value
  // derived from the key, not the key itself) for a year.
  app.post('/auth/login', async (c) => {
    const ip = remoteOf(c)?.ip ?? 'unknown';
    const local = isThisMachine(ip);
    if (!local && keyMisses.blocked(ip)) return c.json({ error: 'too many wrong keys from this address — wait a minute' }, 429);
    let given = '';
    try {
      given = String(((await c.req.json()) as { key?: unknown }).key ?? '').trim();
    } catch {
      /* empty or not JSON */
    }
    if (!keyStore.accepts({ kind: 'key', value: given })) {
      if (!local) keyMisses.miss(ip);
      logger.warn({ msg: 'auth.login_refused', ip });
      return c.json({ error: 'wrong key — run "somora key" on the server to see it' }, 401);
    }
    logger.info({ msg: 'auth.login', ip });
    c.header('set-cookie', keyCookie(c, keyStore.cookieValue(), 365 * 24 * 3600));
    return c.json({ ok: true });
  });

  app.post('/auth/logout', (c) => {
    c.header('set-cookie', keyCookie(c, '', 0));
    return c.json({ ok: true });
  });
}
