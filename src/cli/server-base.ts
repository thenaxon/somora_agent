// Where the running somora server listens, for the thin clients (TUI,
// `somora acp`). With `server.tls` in config.yaml the server is
// HTTPS-only on its publicHost (the certificate's name), so a client
// has to follow. Env wins for power users: SOMORA_BASE forces a URL,
// SOMORA_TLS=1/0 toggles the scheme, SOMORA_HOST/SOMORA_PORT override
// the parts.

import { loadConfig } from '../config/loader.ts';

export async function resolveServerBase(): Promise<string> {
  let cfg: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    cfg = await loadConfig();
  } catch {
    /* missing config = first run, plain-HTTP defaults */
  }
  // server.port from config.yaml, as the server itself uses it; the env
  // overrides it. The TUI and `somora acp` used to take 18737 whatever
  // config.yaml said (Fable review, docs vs code 1).
  const port = Number(process.env.SOMORA_PORT ?? cfg?.server.port ?? 18737);
  const tlsEnv = process.env.SOMORA_TLS;
  const useTls = tlsEnv === '0' ? false : tlsEnv === '1' ? true : !!cfg?.server.tls;
  const scheme = useTls ? 'https' : 'http';
  const defaultHost = useTls ? (cfg?.server.tls?.publicHost ?? '127.0.0.1') : '127.0.0.1';
  const host = process.env.SOMORA_HOST ?? defaultHost;
  return process.env.SOMORA_BASE ?? `${scheme}://${host}:${port}`;
}
