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
// Which credential authenticates Claude Design changed twice in four
// days: the separate /design-login token, then the ordinary login, then
// back again once Anthropic split out a user:design:* scope. The preset
// names both in preference order so the next move costs no config edit,
// and the provider takes whichever key is actually in the file.
check(
  'preset: prefers designOauth, falls back to the regular login',
  JSON.stringify(out.auth?.credentialKey) === JSON.stringify(['designOauth', 'claudeAiOauth']),
  JSON.stringify(out.auth?.credentialKey),
);
  // Refresh ownership is per key: designOauth is somora's (nothing
  // else kept it alive — daily manual /design-login, 2026-08-31),
  // claudeAiOauth stays the CLI's.
  check(
    'preset: refresh owned for designOauth only',
    JSON.stringify(out.auth?.refresh) === JSON.stringify(['designOauth']),
    JSON.stringify(out.auth?.refresh),
  );
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

// ── credential selection: first key PRESENT wins ──────────────────
// The preferred credential only exists after its own interactive login
// has been run, so "prefer designOauth" has to mean "use it if it is
// there", not "fail without it". Both directions are asserted, because
// getting this backwards fails in the least visible way: a token that
// authenticates for everything else, and a 403 only from one endpoint.
{
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const dir = mkdtempSync(pjoin(tmpdir(), 'somora-cred-'));
  const file = pjoin(dir, 'creds.json');

  const providerFor = (keys: string[]) =>
    new OAuthRefreshProvider(
      {
        type: 'oauth-refresh',
        credentialFile: file,
        credentialKey: keys,
        tokenEndpoint: 'https://example.invalid/token',
        refresh: false,
      },
      {},
    );

  const far = Date.now() + 60 * 60 * 1000;

  writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'general-token', expiresAt: far },
  }));
  let headers = await providerFor(['designOauth', 'claudeAiOauth']).resolveHeaders();
  check('falls back when the preferred key is absent',
    headers.authorization === 'Bearer general-token', headers.authorization);

  writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'general-token', expiresAt: far },
    designOauth: { accessToken: 'design-token', expiresAt: far },
  }));
  headers = await providerFor(['designOauth', 'claudeAiOauth']).resolveHeaders();
  check('prefers the design credential once it exists',
    headers.authorization === 'Bearer design-token', headers.authorization);

  // A plain string must keep working — every other server config uses one.
  const single = new OAuthRefreshProvider(
    {
      type: 'oauth-refresh',
      credentialFile: file,
      credentialKey: 'claudeAiOauth',
      tokenEndpoint: 'https://example.invalid/token',
      refresh: false,
    },
    {},
  );
  headers = await single.resolveHeaders();
  check('a single key string still works',
    headers.authorization === 'Bearer general-token', headers.authorization);

  // Neither present: the message must name what was looked for, or the
  // operator is left guessing which login to run.
  writeFileSync(file, JSON.stringify({ somethingElse: { accessToken: 'x' } }));
  let msg = '';
  try {
    await providerFor(['designOauth', 'claudeAiOauth']).resolveHeaders();
  } catch (err) {
    msg = (err as Error).message;
  }
  check('with none present it names every key it tried',
    msg.includes('designOauth') && msg.includes('claudeAiOauth'), msg);
  check('and points at the interactive login', msg.includes('login'), msg);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
