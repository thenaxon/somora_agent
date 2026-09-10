// Which session does a reference mean?
//
// 2026-09-09: a session appeared in the list as `browser-smoke`, but
// archiving it hit `20260908-171439_browser-smoke` — a different
// conversation that happened to end in the same word — and answered
// HTTP 200 three times. Anything the list shows has to be addressable
// under the name it was shown with.
//
// Run: npm test src/storage/sessions-resolve.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-sessions-'));
const { resolveSessionId } = await import('./sessions.ts');

const dir = join(process.env.SOMORA_HOME, 'agents', 'lisa', 'sessions');
mkdirSync(dir, { recursive: true });
const put = (id: string) => writeFileSync(join(dir, `${id}.jsonl`), '');

put('20260908-171439_browser-smoke');
put('20260909-090000_browser-smoke');
put('browser-smoke'); // legacy: written under a raw reference
put('20260907-101010_research');

test('main is always addressable', async () => {
  assert.equal(await resolveSessionId('lisa', 'main'), 'main');
});

test('an exact id means that file, and nothing else', async () => {
  assert.equal(await resolveSessionId('lisa', '20260908-171439_browser-smoke'), '20260908-171439_browser-smoke');
  assert.equal(await resolveSessionId('lisa', '20260101-000000_browser-smoke'), null, 'an id with no file is not a session');
});

test('a session listed under its own raw name resolves to itself', async () => {
  // The bug: this used to answer with the newest _browser-smoke file, so
  // the raw one could be listed but never archived, read or continued.
  assert.equal(await resolveSessionId('lisa', 'browser-smoke'), 'browser-smoke');
});

test('a slug still means the newest session with that slug', async () => {
  assert.equal(await resolveSessionId('lisa', 'research'), '20260907-101010_research');
});

test('an unknown or malformed reference is refused, never guessed', async () => {
  assert.equal(await resolveSessionId('lisa', 'nothing-like-this'), null);
  assert.equal(await resolveSessionId('lisa', '../escape'), null);
  assert.equal(await resolveSessionId('lisa', 'with space'), null);
});
