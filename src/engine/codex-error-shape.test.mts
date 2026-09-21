// codex `error` notifications: read the real shape, tell a retry from a failure.
// Run: npx tsx src/engine/codex-error-shape.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-codex-err-'));
const { readCodexError } = await import('./codex-cli.ts');
const { resolveEngineMetaLabel, summariseEngineMeta } = await import('./engine-meta-labels.ts');

// Verbatim from the live log, 2026-09-14.
const live = JSON.parse(
  '{"error":{"message":"Reconnecting... 2/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}},"additionalDetails":"stream disconnected before completion: websocket closed by server before response.completed","misalignment":null},"willRetry":true,"threadId":"t","turnId":"u"}',
);
const r = readCodexError(live);
assert.equal(r.willRetry, true);
assert.match(r.message, /^Reconnecting\.\.\. 2\/5 — stream disconnected/);
assert.ok(!r.message.includes('{'), 'readable text, not a stringified object');

// A real failure: no willRetry.
const fatal = readCodexError({ error: { message: "Unsupported value: 'xhigh' is not supported with this model." } });
assert.equal(fatal.willRetry, false);
assert.match(fatal.message, /Unsupported value/, 'the reasoning-effort check reads this text');

// Older / other shapes keep working.
assert.deepEqual(readCodexError({ message: 'plain' }), { message: 'plain', willRetry: false });
assert.equal(readCodexError({ willRetry: 'yes' as never }).willRetry, false, 'only a real true counts');
assert.ok(readCodexError({ odd: 1 }).message.includes('odd'));

assert.equal(resolveEngineMetaLabel('codex-cli', 'reconnecting'), 'reconnecting');
assert.equal(resolveEngineMetaLabel('codex-cli', 'transport_fallback'), 'transport fallback');
assert.equal(summariseEngineMeta('codex-cli', 'reconnecting', { text: 'x' }), 'x');
console.log('codex-error-shape: all passed');
