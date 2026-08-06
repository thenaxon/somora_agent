// Unit tests for MCP import hygiene (schema normalization ported from
// hermes-agent, naming rules, unicode sanitizing).
//
// Run: npx tsx src/mcp/hub/normalize.test.mts

import assert from 'node:assert/strict';
import {
  buildToolNames,
  capDescription,
  MAX_MCP_DESCRIPTION_CHARS,
  normalizeInputSchema,
  sanitizeUnicodeString,
  scrubCredentials,
} from './normalize.ts';

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

// --- Fix 1: definitions → $defs, meta-keyword only -----------------------

{
  const out = normalizeInputSchema({
    type: 'object',
    properties: { a: { $ref: '#/definitions/Thing' } },
    definitions: { Thing: { type: 'string' } },
  });
  check('defs: meta-keyword renamed', out !== null && '$defs' in out && !('definitions' in out));
  const ref = (out!.properties as Record<string, { $ref: string }>).a!.$ref;
  check('defs: $ref rewritten', ref === '#/$defs/Thing', ref);
}

{
  // A tool PARAMETER literally named `definitions` must keep its name.
  const out = normalizeInputSchema({
    type: 'object',
    properties: { definitions: { type: 'array', items: { type: 'string' } } },
  });
  const props = out?.properties as Record<string, unknown>;
  check('defs: property name untouched', props !== undefined && 'definitions' in props && !('$defs' in props));
}

// --- Fix 2 + 3: type default + empty properties ---------------------------

{
  const out = normalizeInputSchema({ properties: { q: { type: 'string' } } });
  check('type: object defaulted on root', out?.type === 'object');
}

{
  const out = normalizeInputSchema({ type: 'object', required: ['q'] });
  check('props: empty properties injected', out !== null && typeof out.properties === 'object');
  check('props: dangling required dropped', out !== null && !('required' in out));
}

// --- Fix 4: required pruned to existing properties ------------------------

{
  const out = normalizeInputSchema({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'ghost'],
  });
  check('required: pruned', JSON.stringify(out?.required) === '["a"]');
}

// --- Fix 5: nullable anyOf collapse ---------------------------------------

{
  const out = normalizeInputSchema({
    type: 'object',
    properties: {
      limit: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], default: null },
    },
  });
  const limit = (out!.properties as Record<string, Record<string, unknown>>).limit!;
  check('anyOf: collapsed to non-null branch', limit.type === 'integer' && limit.minimum === 1);
  check('anyOf: union gone', !('anyOf' in limit) && !('default' in limit));
}

// --- structural rejects ---------------------------------------------------

check('reject: non-object root type', normalizeInputSchema({ type: 'string' }) === null);
check('reject: array root', normalizeInputSchema([1, 2]) === null);
{
  const out = normalizeInputSchema(undefined);
  check('missing schema: zero-arg object', out !== null && out.type === 'object');
}

// --- naming ---------------------------------------------------------------

{
  const r = buildToolNames('parallel', ['web_search', 'web.fetch']);
  check(
    'names: sanitized + prefixed',
    r.accepted.some((t) => t.fullName === 'mcp__parallel__web_search') &&
      r.accepted.some((t) => t.fullName === 'mcp__parallel__web_fetch'),
  );
  check('names: raw preserved', r.accepted.find((t) => t.fullName === 'mcp__parallel__web_fetch')?.rawName === 'web.fetch');
}

{
  // read.file and read_file sanitize to the same name → both skipped.
  const r = buildToolNames('srv', ['read_file', 'read.file']);
  check('collision: fail closed', r.accepted.length === 0 && r.skipped.length === 2);
}

{
  const long = 'x'.repeat(80);
  const r = buildToolNames('srv', [long]);
  check('length: over-64 skipped, not truncated', r.accepted.length === 0 && r.skipped[0]!.reason.includes('64'));
}

// --- unicode + description + credentials ----------------------------------

check('unicode: zero-width stripped', sanitizeUnicodeString('a​b‮c') === 'abc');
{
  const capped = capDescription('d'.repeat(MAX_MCP_DESCRIPTION_CHARS + 100));
  check('description: capped with marker', capped.length < MAX_MCP_DESCRIPTION_CHARS + 20 && capped.endsWith('[truncated]'));
}
check(
  'scrub: bearer + key shapes',
  scrubCredentials('Authorization: Bearer abcdef123456 sk-liveXXXXXXXXXXXX ghp_ABCDEF1234567890').includes('[redacted]') &&
    !scrubCredentials('Bearer abcdef123456').includes('abcdef123456'),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
