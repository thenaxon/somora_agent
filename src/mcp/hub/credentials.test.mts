// Unit tests for MCP hub credential providers + preset expansion.
// The live OAuth refresh flow is verified end-to-end against the real
// endpoint, not here — these cover config wiring and header shaping.
//
// Run: npx tsx src/mcp/hub/credentials.test.mts

import assert from 'node:assert/strict';
import type { McpServerConfig } from '../../config/types.ts';
import {
  applyMcpPreset,
  assertHasUrl,
  buildCredentialProvider,
  OAuthRefreshProvider,
  StaticHeaderProvider,
} from './credentials.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function base(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    transport: 'http',
    headers: {},
    enabled: true,
    tools: { include: [], exclude: [] },
    timeoutMs: 60_000,
    connectTimeoutMs: 15_000,
    supportsParallelToolCalls: false,
    ...overrides,
  } as McpServerConfig;
}

// --- preset: claude-design fills url/auth/headers -----------------------
{
  const out = applyMcpPreset('claude-design', base({ preset: 'claude-design' }));
  check('preset: url filled', out.url === 'https://api.anthropic.com/v1/design/mcp');
  check('preset: auth oauth-refresh', out.auth?.type === 'oauth-refresh');
  check('preset: credentialKey designOauth', out.auth?.credentialKey === 'designOauth');
  check('preset: tokenEndpoint', out.auth?.tokenEndpoint === 'https://platform.claude.com/v1/oauth/token');
  check('preset: X-Anthropic-Client header', out.headers['X-Anthropic-Client'] === 'claude-cli-design-tool');
}

// --- explicit fields override the preset --------------------------------
{
  const out = applyMcpPreset(
    'cd',
    base({ preset: 'claude-design', url: 'https://custom/mcp', headers: { 'X-Anthropic-Client': 'mine' } }),
  );
  check('override: url kept', out.url === 'https://custom/mcp');
  check('override: header kept', out.headers['X-Anthropic-Client'] === 'mine');
}

// --- no preset = untouched ---------------------------------------------
{
  const cfg = base({ url: 'https://x/mcp' });
  check('no-preset: unchanged', applyMcpPreset('x', cfg) === cfg);
}

// --- provider selection -------------------------------------------------
{
  const staticCfg = base({ url: 'https://x/mcp', headers: { 'x-api-key': 'k' } });
  check('provider: static for no auth', buildCredentialProvider(staticCfg) instanceof StaticHeaderProvider);
  const oauthCfg = applyMcpPreset('cd', base({ preset: 'claude-design' }));
  check('provider: oauth for oauth-refresh', buildCredentialProvider(oauthCfg) instanceof OAuthRefreshProvider);
}

// --- static provider: env expansion + lowercase -------------------------
{
  process.env.__TEST_MCP_KEY = 'secret123';
  const p = new StaticHeaderProvider({ 'X-Api-Key': '${__TEST_MCP_KEY}' });
  const h = await p.resolveHeaders();
  check('static: expanded + lowercased', h['x-api-key'] === 'secret123', JSON.stringify(h));
  delete process.env.__TEST_MCP_KEY;
}

// --- assertHasUrl -------------------------------------------------------
check('assertHasUrl: throws without url', (() => {
  try {
    assertHasUrl('x', base({}));
    return false;
  } catch {
    return true;
  }
})());
check('assertHasUrl: returns url', assertHasUrl('x', base({ url: 'https://x/mcp' })) === 'https://x/mcp');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
