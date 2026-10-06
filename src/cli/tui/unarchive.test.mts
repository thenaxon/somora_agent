// /sessions archived and /unarchive in the TUI, against a stand-in API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, type CommandContext } from './commands.ts';
import type { SessionSummary } from './types.ts';

function row(id: string, slug: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, slug, isMain: id === 'main', createdAt: null, lastActivity: '2026-10-06T10:00:00.000Z', messageCount: 4, ...extra };
}

function ctxWith(rows: SessionSummary[]) {
  const calls: string[] = [];
  const api = {
    async fetchSessions(_agent: string, opts: { includeArchived?: boolean } = {}) {
      return opts.includeArchived ? rows : rows.filter((r) => !r.isArchived);
    },
    async unarchiveSession(_agent: string, session: string) {
      calls.push(session);
      const r = rows.find((x) => x.id === session)!;
      return { session, slug: r.slug };
    },
  };
  const ctx = {
    api,
    agent: 'ada',
    session: 'main',
    showMemory: false,
    showTools: false,
    verboseTools: false,
    verboseMemory: false,
    verboseSystem: false,
    verboseThinking: false,
  } as unknown as CommandContext;
  return { ctx, calls };
}

const rows = [
  row('main', 'main'),
  row('20261006-101500_trip', 'trip'),
  row('20261006-101600_20261006-101500_trip-archive', 'trip-archive', { isArchived: true, archivedAt: '2026-10-06T10:16:00.000Z' }),
  row('20261005-090000_main-archive', 'main-archive', { isArchived: true, archivedAt: '2026-10-05T09:00:00.000Z' }),
  row('20261006-080000_main-archive', 'main-archive', { isArchived: true, archivedAt: '2026-10-06T08:00:00.000Z' }),
];

test('/sessions archived lists only archived sessions, newest first, with ids', async () => {
  const { ctx } = ctxWith(rows);
  const [a] = await runCommand('/sessions archived', ctx);
  assert.equal(a!.kind, 'notice');
  const text = (a as { text: string }).text;
  assert.match(text, /trip-archive/);
  assert.doesNotMatch(text, /\btrip\s{2,}/, 'the live session is not listed');
  assert.ok(text.indexOf('20261006-101600') < text.indexOf('20261006-080000'));
  assert.ok(text.indexOf('20261006-080000') < text.indexOf('20261005-090000'));
  assert.match(text, /\/unarchive/);
});

test('/unarchive by name restores and switches to the session', async () => {
  const { ctx, calls } = ctxWith(rows);
  const out = await runCommand('/unarchive trip-archive', ctx);
  assert.deepEqual(calls, ['20261006-101600_20261006-101500_trip-archive']);
  assert.match((out[0] as { text: string }).text, /back as 'trip-archive'/);
  assert.deepEqual(out[1], { kind: 'switchTo', agent: 'ada', session: '20261006-101600_20261006-101500_trip-archive' });
});

test('/unarchive with an ambiguous name lists the ids and restores nothing', async () => {
  const { ctx, calls } = ctxWith(rows);
  const out = await runCommand('/unarchive main-archive', ctx);
  assert.equal(calls.length, 0);
  const text = (out[0] as { text: string }).text;
  assert.match(text, /matches 2 archived sessions/);
  assert.match(text, /\/unarchive 20261005-090000_main-archive/);
  assert.match(text, /\/unarchive 20261006-080000_main-archive/);
});

test('/unarchive by id picks exactly that archive', async () => {
  const { ctx, calls } = ctxWith(rows);
  await runCommand('/unarchive 20261005-090000_main-archive', ctx);
  assert.deepEqual(calls, ['20261005-090000_main-archive']);
});

test('/unarchive of an unknown or live session says so', async () => {
  const { ctx, calls } = ctxWith(rows);
  const out = await runCommand('/unarchive trip', ctx);
  assert.equal(calls.length, 0);
  assert.match((out[0] as { text: string }).text, /no archived session 'trip'/);
});

test('/session on an archived session points to /unarchive instead of opening it', async () => {
  const { ctx } = ctxWith(rows);
  const out = await runCommand('/session trip-archive', ctx);
  assert.equal(out.length, 1);
  assert.match((out[0] as { text: string }).text, /is archived\. \/unarchive 20261006-101600_20261006-101500_trip-archive/);
});

test('/session still opens a live session', async () => {
  const { ctx } = ctxWith(rows);
  const out = await runCommand('/session trip', ctx);
  assert.deepEqual(out, [{ kind: 'switchTo', agent: 'ada', session: 'trip' }]);
});
