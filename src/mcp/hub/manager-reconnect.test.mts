// Regression test: a hub server whose LIVE connection drops (keepalive
// ping fails) must come back on its own once the upstream is reachable
// again. Before 2026-08-25 the keepalive sweep only re-probed `parked`
// servers, so a keepalive teardown left the server in `pending` forever
// (parallel stranded 47 min, claude-design 84 min).
//
// Run: npx tsx src/mcp/hub/manager-reconnect.test.mts

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpConfigSchema } from '../../config/types.ts';
import { McpHubManager } from './manager.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Minimal stateless streamable-http MCP server with one tool. */
async function startUpstream(port: number): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const http: Server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'fake-upstream', version: '1' });
    mcp.tool('echo', { text: z.string() }, async ({ text }) => ({
      content: [{ type: 'text', text }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  http.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => http.listen(port, '127.0.0.1', r));
  return {
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const PORT = 18000 + Math.floor(Math.random() * 1000);
const cfg = McpConfigSchema.parse({
  servers: { up: { url: `http://127.0.0.1:${PORT}/mcp` } },
});

// Poke privates: the sweep is timer-driven (60s) and gated on a 180s
// idle window — both far too slow for a test.
type Internals = {
  keepaliveSweep: () => Promise<void>;
  servers: Map<string, { lastActivityAt: number; retryNotBefore: number; state: string; parked: boolean }>;
};

let upstream = await startUpstream(PORT);
const hub = new McpHubManager(cfg);
const internals = hub as unknown as Internals;
const rt = () => internals.servers.get('up')!;

await hub.ensureConnected('up');
check('initial connect', hub.status().up?.state === 'connected', JSON.stringify(hub.status().up));
check('tool imported', hub.status().up?.toolCount === 1);

// ── upstream dies → keepalive ping fails → teardown ──
await upstream.close();
rt().lastActivityAt = 0; // force the ping
await internals.keepaliveSweep();
check('after keepalive failure: pending', rt().state === 'pending', rt().state);
check('after keepalive failure: retry armed in the future', rt().retryNotBefore > Date.now());
check('after keepalive failure: not parked', rt().parked === false);

// ── sweep while still down + window elapsed → connect attempt fails, backoff ──
rt().retryNotBefore = 0;
await internals.keepaliveSweep();
await new Promise((r) => setTimeout(r, 300)); // ensureConnected is fire-and-forget in the sweep
check('retry while down: failed', rt().state === 'failed', rt().state);
check('retry while down: counted', hub.status().up?.consecutiveFailures === 1);
check('retry while down: backoff armed', rt().retryNotBefore > Date.now());

// ── upstream returns → next sweep reconnects without manual help ──
upstream = await startUpstream(PORT);
rt().retryNotBefore = 0;
await internals.keepaliveSweep();
for (let i = 0; i < 30 && rt().state !== 'connected'; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
check('sweep reconnects on its own', rt().state === 'connected', rt().state);
check('failure counter reset', hub.status().up?.consecutiveFailures === 0);
const call = await hub.callTool('up', 'echo', { text: 'hi' });
check('tool call works after reconnect', call.text === 'hi', JSON.stringify(call));

await hub.shutdown();
await upstream.close();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
