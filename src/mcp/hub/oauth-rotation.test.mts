// Integration test: the hub keeps a somora-owned OAuth credential alive
// on its own (2026-08-31 report: designOauth expired every ~8 h and
// needed a manual /design-login, plus a hand-edit of .credentials.json
// to get past "A design credential is already stored").
//
//   1. connect with a near-expiry token → refreshed on the way in, the
//      rotated refresh_token is persisted, the sibling key is untouched,
//      the upstream sees the NEW bearer
//   2. the refreshed token is short-lived → the keepalive sweep rotates
//      it proactively (teardown + reconnect + refresh) with no 401 ever
//      reaching the upstream
//   3. the token endpoint rejects the refresh → the dead entry is moved
//      aside as <key>_stale_<ts>, the server parks as needs-auth with a
//      message that names the login to run
//   4. a key the hub does NOT own (claudeAiOauth) is never refreshed,
//      even when near expiry
//
// Run: npx tsx src/mcp/hub/oauth-rotation.test.mts

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpConfigSchema } from '../../config/types.ts';
import { McpHubManager } from './manager.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
void assert;

// ── fake token endpoint: rotates access+refresh, or rejects ────────
let tokenSeq = 0;
let tokenMode: 'ok' | 'reject' = 'ok';
let tokenExpiresInSec = 3600;
const refreshCalls: Array<{ refresh_token: string; client_id?: string }> = [];
const validBearers = new Set<string>(['access-0']);
const tokenSockets = new Set<Socket>();
const tokenSrv: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const j = JSON.parse(body || '{}') as { refresh_token: string; client_id?: string; grant_type?: string };
    refreshCalls.push({ refresh_token: j.refresh_token, ...(j.client_id ? { client_id: j.client_id } : {}) });
    if (tokenMode === 'reject') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    tokenSeq += 1;
    const access = `access-${tokenSeq}`;
    validBearers.add(access);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: access,
        refresh_token: `refresh-${tokenSeq}`,
        expires_in: tokenExpiresInSec,
        scope: 'user:design:read user:design:write',
      }),
    );
  });
});
tokenSrv.on('connection', (s) => {
  tokenSockets.add(s);
  s.on('close', () => tokenSockets.delete(s));
});

// ── fake upstream MCP server that checks the bearer ─────────────────
const seenBearers: string[] = [];
let rejected401 = 0;
async function startUpstream(port: number): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const http: Server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const bearer = auth.replace(/^Bearer /, '');
    seenBearers.push(bearer);
    if (!validBearers.has(bearer)) {
      rejected401 += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'OAuth access token has expired. Re-authenticate to continue.' } }));
      return;
    }
    const mcp = new McpServer({ name: 'fake-design', version: '1' });
    mcp.tool('list_design_systems', {}, async () => ({ content: [{ type: 'text', text: '[]' }] }));
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

// ── credentials file ────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'somora-oauth-rotation-'));
const credFile = join(dir, '.credentials.json');
function writeCreds(designExpiresAt: number, cliExpiresAt: number): void {
  writeFileSync(
    credFile,
    JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: 'cli-access',
          refreshToken: 'cli-refresh',
          expiresAt: cliExpiresAt,
          scopes: ['user:inference'],
        },
        designOauth: {
          accessToken: 'access-0',
          refreshToken: 'refresh-0',
          expiresAt: designExpiresAt,
          clientId: 'design-client',
          scopes: ['user:design:read', 'user:design:write'],
        },
      },
      null,
      2,
    ),
  );
}
const readCreds = () => JSON.parse(readFileSync(credFile, 'utf8')) as Record<string, { accessToken: string; refreshToken: string; expiresAt: number }>;

const UP_PORT = 18100 + Math.floor(Math.random() * 800);
const TOKEN_PORT = UP_PORT + 1;
await new Promise<void>((r) => tokenSrv.listen(TOKEN_PORT, '127.0.0.1', r));
let upstream = await startUpstream(UP_PORT);

const cfg = McpConfigSchema.parse({
  servers: {
    design: {
      url: `http://127.0.0.1:${UP_PORT}/mcp`,
      auth: {
        type: 'oauth-refresh',
        credentialFile: credFile,
        credentialKey: ['designOauth', 'claudeAiOauth'],
        tokenEndpoint: `http://127.0.0.1:${TOKEN_PORT}/token`,
        refresh: ['designOauth'],
      },
    },
  },
});

type Internals = {
  keepaliveSweep: () => Promise<void>;
  servers: Map<string, { state: string; retryNotBefore: number; lastError?: string }>;
};

// ── 1. near-expiry at connect → refreshed on the way in ────────────
writeCreds(Date.now() + 60_000, Date.now() + 3_600_000); // design expires in 1 min (< 5 min skew)
let hub = new McpHubManager(cfg);
let internals = hub as unknown as Internals;
await hub.ensureConnected('design');
check('1: connected', hub.status().design?.state === 'connected', JSON.stringify(hub.status().design));
check('1: token endpoint called once', refreshCalls.length === 1, String(refreshCalls.length));
check('1: refresh used the stored refresh_token + client_id', refreshCalls[0]?.refresh_token === 'refresh-0' && refreshCalls[0]?.client_id === 'design-client', JSON.stringify(refreshCalls[0]));
check('1: upstream saw the NEW bearer', seenBearers.every((b) => b === 'access-1'), JSON.stringify(seenBearers));
{
  const c = readCreds();
  check('1: rotated access token persisted', c.designOauth?.accessToken === 'access-1');
  check('1: rotated refresh token persisted', c.designOauth?.refreshToken === 'refresh-1');
  check('1: expiresAt moved into the future', (c.designOauth?.expiresAt ?? 0) > Date.now() + 3_000_000);
  check('1: sibling claudeAiOauth untouched', c.claudeAiOauth?.accessToken === 'cli-access' && c.claudeAiOauth?.refreshToken === 'cli-refresh');
}
const call1 = await hub.callTool('design', 'list_design_systems', {});
check('1: tool call works', call1.text === '[]', JSON.stringify(call1));
await hub.shutdown();

// ── 2. short-lived token → proactive rotation by the sweep ─────────
tokenExpiresInSec = 200; // refreshed token expires in 200s → inside the skew immediately
writeCreds(Date.now() + 60_000, Date.now() + 3_600_000);
seenBearers.length = 0;
refreshCalls.length = 0;
hub = new McpHubManager(cfg);
internals = hub as unknown as Internals;
await hub.ensureConnected('design');
const afterConnect = refreshCalls.length; // 1 (connect-time refresh)
const bearerAfterConnect = seenBearers[seenBearers.length - 1];
await internals.keepaliveSweep(); // refreshDue() → teardown + reconnect + refresh
for (let i = 0; i < 50 && hub.status().design?.state !== 'connected'; i++) await delay(100);
check('2: connected again after rotation', hub.status().design?.state === 'connected', JSON.stringify(hub.status().design));
check('2: sweep triggered exactly one more refresh', refreshCalls.length === afterConnect + 1, `${afterConnect} → ${refreshCalls.length}`);
check('2: rotation chained on the rotated refresh_token', refreshCalls[refreshCalls.length - 1]?.refresh_token === `refresh-${tokenSeq - 1}`, JSON.stringify(refreshCalls));
const bearerAfterSweep = seenBearers[seenBearers.length - 1];
check('2: upstream now sees a newer bearer', bearerAfterSweep !== bearerAfterConnect && bearerAfterSweep === `access-${tokenSeq}`, `${bearerAfterConnect} → ${bearerAfterSweep}`);
check('2: the upstream never saw an expired bearer (no 401)', rejected401 === 0, String(rejected401));
const call2 = await hub.callTool('design', 'list_design_systems', {});
check('2: tool call works after rotation', call2.text === '[]');
await hub.shutdown();

// ── 3. refresh rejected → entry retired, needs-auth, actionable ────
tokenMode = 'reject';
tokenExpiresInSec = 3600;
writeCreds(Date.now() + 60_000, Date.now() + 3_600_000);
refreshCalls.length = 0;
hub = new McpHubManager(cfg);
internals = hub as unknown as Internals;
await hub.ensureConnected('design').catch(() => {});
const st3 = hub.status().design;
check('3: parked as needs-auth', st3?.state === 'needs-auth', JSON.stringify(st3));
check('3: lastError names the retired key + the login to run', /moved to "designOauth_stale_/.test(st3?.lastError ?? '') && /design-login/.test(st3?.lastError ?? ''), st3?.lastError);
{
  const c = readCreds();
  const staleKeys = Object.keys(c).filter((k) => k.startsWith('designOauth_stale_'));
  check('3: designOauth key removed from the file', c.designOauth === undefined, Object.keys(c).join(','));
  check('3: … and kept aside as designOauth_stale_<ts>', staleKeys.length === 1 && c[staleKeys[0]!]?.refreshToken === 'refresh-0', staleKeys.join(','));
  check('3: claudeAiOauth still there', c.claudeAiOauth?.accessToken === 'cli-access');
}
await hub.shutdown();

// ── 4. a key the hub does not own is never refreshed ───────────────
tokenMode = 'ok';
refreshCalls.length = 0;
seenBearers.length = 0;
// Only claudeAiOauth present, near expiry, and valid upstream.
writeFileSync(
  credFile,
  JSON.stringify({ claudeAiOauth: { accessToken: 'cli-access', refreshToken: 'cli-refresh', expiresAt: Date.now() + 60_000 } }, null, 2),
);
validBearers.add('cli-access');
hub = new McpHubManager(cfg);
internals = hub as unknown as Internals;
await hub.ensureConnected('design');
check('4: connected on the read-only key', hub.status().design?.state === 'connected', JSON.stringify(hub.status().design));
check('4: no refresh attempted for claudeAiOauth', refreshCalls.length === 0, String(refreshCalls.length));
check('4: upstream got the CLI bearer as-is', seenBearers.every((b) => b === 'cli-access'), JSON.stringify(seenBearers));
await internals.keepaliveSweep();
check('4: sweep does not rotate a key it does not own', refreshCalls.length === 0 && hub.status().design?.state === 'connected');
check('4: file untouched', readCreds().claudeAiOauth?.refreshToken === 'cli-refresh');
await hub.shutdown();

await upstream.close();
for (const s of tokenSockets) s.destroy();
await new Promise<void>((r) => tokenSrv.close(() => r()));
rmSync(dir, { recursive: true, force: true });

console.log(`oauth-rotation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
