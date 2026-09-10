// The log reader behind the log window: never read the whole file, and
// never let a byte window invent half a line.
//
// Run: npm test src/server/logs.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'somora-logs-'));
process.env.SOMORA_HOME = home;
const logDir = join(home, 'logs');
mkdirSync(logDir, { recursive: true });

const line = (o: Record<string, unknown>) => `${JSON.stringify({ time: 1_700_000_000_000, level: 30, ...o })}\n`;
const today = join(logDir, 'server.2026-09-10.1.log');
writeFileSync(
  today,
  line({ msg: 'turn.completed', agent: 'lisa' }) +
    line({ msg: 'engine.fail', level: 50, agent: 'hans', err: 'boom' }) +
    line({ msg: 'http', level: 30 }) +
    'not json at all\n' +
    line({ msg: 'browser.open', level: 30, agent: 'lisa' }),
);
writeFileSync(join(logDir, 'server.2026-09-09.1.log'), line({ msg: 'yesterday' }));

const { listLogDays, readLogTail, readLogSince } = await import('./logs.ts');

test('days are listed newest first', async () => {
  assert.deepEqual(await listLogDays(), ['2026-09-10', '2026-09-09']);
});

test('the newest day is read by default, garbage lines are skipped', async () => {
  const snap = await readLogTail();
  assert.equal(snap.day, '2026-09-10');
  assert.deepEqual(snap.lines.map((l) => l.msg), ['turn.completed', 'engine.fail', 'http', 'browser.open']);
  assert.equal(snap.truncated, false);
  assert.ok(snap.offset > 0);
});

test('filters narrow it down without reading anything else', async () => {
  assert.deepEqual((await readLogTail({ minLevel: 50 })).lines.map((l) => l.msg), ['engine.fail']);
  assert.deepEqual((await readLogTail({ agent: 'lisa' })).lines.map((l) => l.msg), ['turn.completed', 'browser.open']);
  assert.deepEqual((await readLogTail({ q: 'BOOM' })).lines.map((l) => l.msg), ['engine.fail'], 'the search is case-insensitive');
  assert.equal((await readLogTail({ limit: 1 })).lines.length, 1, 'the newest line wins when limited');
});

test('an older day can be asked for, an unknown one answers empty', async () => {
  assert.deepEqual((await readLogTail({ day: '2026-09-09' })).lines.map((l) => l.msg), ['yesterday']);
  const missing = await readLogTail({ day: '1999-01-01' });
  assert.deepEqual(missing.lines, []);
});

test('following reads only what was appended', async () => {
  const snap = await readLogTail();
  const quiet = await readLogSince(snap.offset);
  assert.deepEqual(quiet.lines, [], 'nothing new, nothing read');
  assert.equal(quiet.offset, snap.offset);

  appendFileSync(today, line({ msg: 'tool.call', agent: 'hans' }));
  const after = await readLogSince(snap.offset);
  assert.deepEqual(after.lines.map((l) => l.msg), ['tool.call']);
  assert.ok(after.offset > snap.offset);
});

test('a rotated or truncated file does not read backwards', async () => {
  const beyond = await readLogSince(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(beyond.lines, []);
  assert.ok(beyond.offset < Number.MAX_SAFE_INTEGER, 'the offset snaps back to the real size');
});

test('the level field survives as a number the client can colour by', async () => {
  const snap = await readLogTail({ minLevel: 50 });
  assert.equal(snap.lines[0]?.level, 50);
  assert.equal(snap.lines[0]?.agent, 'hans');
  assert.equal(snap.lines[0]?.fields.err, 'boom', 'the rest of the line is kept for the detail view');
});
