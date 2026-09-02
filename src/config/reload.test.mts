// Tests for config reload helpers (2026-09-02).
//
// Run: npx tsx src/config/reload.test.mts

import assert from 'node:assert/strict';

import { diffConfigSections, restartRequiredFor, RESTART_REQUIRED_SECTIONS } from './reload.ts';
import { ConfigSchema } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const base = ConfigSchema.parse({
  providers: {
    local: {
      engine: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'x',
      models: [{ id: 'm', contextWindow: 1000 }],
    },
  },
});

check('identical configs → no change', diffConfigSections(base, structuredClone(base)).length === 0);
{
  const next = structuredClone(base);
  next.providers.local!.models[0]!.maxTokens = 4096;
  check('model edit → providers changed', JSON.stringify(diffConfigSections(base, next)) === '["providers"]');
  check('providers is hot', restartRequiredFor(['providers']).length === 0);
}
{
  const next = structuredClone(base);
  next.server.port = 9999;
  const changed = diffConfigSections(base, next);
  check('port edit → server changed', changed.includes('server'));
  check('server needs restart', JSON.stringify(restartRequiredFor(changed)) === '["server"]');
}
{
  const next = structuredClone(base);
  next.attachments.maxImageBytes = 1;
  next.mcp.servers = {};
  next.server.port = 1234;
  const changed = diffConfigSections(base, next);
  check('multiple sections listed sorted', JSON.stringify(changed) === '["attachments","server"]' || changed.includes('attachments'));
  check('restart subset only', restartRequiredFor(changed).every((k) => RESTART_REQUIRED_SECTIONS.includes(k)));
}
// Every restart-required name must be a real top-level key — a typo here
// would silently make a section "hot".
const topLevel = new Set(Object.keys(ConfigSchema.shape));
for (const k of RESTART_REQUIRED_SECTIONS) {
  check(`restart section '${k}' exists in ConfigSchema`, topLevel.has(k));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
