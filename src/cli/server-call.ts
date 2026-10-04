// One request from the CLI to the server running on this machine.
// With HTTPS the connection goes to loopback but is verified against
// the public name — that works where the Tailscale name does not
// resolve locally.

import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

function target(): { port: number; publicHost?: string } {
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  let port = 18737;
  let publicHost: string | undefined;
  try {
    const raw = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as { server?: { port?: unknown; tls?: { publicHost?: unknown } } } | null;
    if (typeof raw?.server?.port === 'number') port = raw.server.port;
    if (typeof raw?.server?.tls?.publicHost === 'string') publicHost = raw.server.tls.publicHost;
  } catch {
    /* defaults */
  }
  // The lockfile knows the port the running server actually bound.
  try {
    const lock = JSON.parse(readFileSync(join(home, 'locks', 'server.lock'), 'utf8')) as { port?: unknown };
    if (typeof lock.port === 'number') port = lock.port;
  } catch {
    /* not running, or no lock */
  }
  return { port, ...(publicHost ? { publicHost } : {}) };
}

export function callServer(path: string, opts: { body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const { port, publicHost } = target();
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  const options = {
    host: '127.0.0.1',
    port,
    path,
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(publicHost ? { Host: `${publicHost}:${port}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
    ...(publicHost ? { servername: publicHost } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (publicHost ? httpsRequest : httpRequest)(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
        } catch {
          reject(new Error(`unexpected answer (HTTP ${res.statusCode})`));
        }
      });
    });
    req.setTimeout(opts.timeoutMs ?? 5000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}
