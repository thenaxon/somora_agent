// Where the running somora server listens, for the thin clients (TUI,
// `somora acp`). With `server.tls` in config.yaml the server is
// HTTPS-only on its publicHost (the certificate's name), so a client
// has to follow. Env wins for power users: SOMORA_BASE forces a URL,
// SOMORA_TLS=1/0 toggles the scheme, SOMORA_HOST/SOMORA_PORT override
// the parts.

import { loadConfig } from '../config/loader.ts';

export async function resolveServerBase(): Promise<string> {
  const port = Number(process.env.SOMORA_PORT ?? 18737);
  let cfg: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    cfg = await loadConfig();
  } catch {
    /* missing config = first run, plain-HTTP defaults */
  }
  const tlsEnv = process.env.SOMORA_TLS;
  const useTls = tlsEnv === '0' ? false : tlsEnv === '1' ? true : !!cfg?.server.tls;
  const scheme = useTls ? 'https' : 'http';
  const defaultHost = useTls ? (cfg?.server.tls?.publicHost ?? '127.0.0.1') : '127.0.0.1';
  const host = process.env.SOMORA_HOST ?? defaultHost;
  return process.env.SOMORA_BASE ?? `${scheme}://${host}:${port}`;
}
