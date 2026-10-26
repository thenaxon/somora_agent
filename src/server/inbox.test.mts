// The inbox: one entry per thing, thresholds before a notice, entries
// that resolve themselves, mute, read, and what the log and the state
// check turn into notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inbox } from './inbox.ts';
import { FAIL_STREAK, GONE_FOR_MS, inboxFromLog, inboxFromState, type InboxStateSources } from './inbox-sources.ts';

function fresh(): { inbox: Inbox; clock: { t: number }; path: string } {
  const clock = { t: 1_000_000 };
  const path = join(mkdtempSync(join(tmpdir(), 'somora-inbox-')), 'inbox.json');
  return { inbox: new Inbox(path, () => clock.t), clock, path };
}
const n = { kind: 'tls' as const, level: 'important' as const, title: 'T', text: 'x' };

test('one entry per thing: more events only bump the counter', () => {
  const { inbox } = fresh();
  inbox.raise('tls', n);
  inbox.raise('tls', n);
  inbox.raise('tls', n);
  const list = inbox.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.count, 3);
  assert.equal(inbox.unread(), 1);
});

test('read stays read while the thing goes on; resolved drops out after a day; reopening is new', () => {
  const { inbox, clock } = fresh();
  inbox.raise('tls', n);
  inbox.markRead();
  inbox.raise('tls', n);
  assert.equal(inbox.unread(), 0, 'another event on a read entry is not new');
  inbox.resolve('tls');
  assert.equal(inbox.list()[0]!.resolvedAt !== undefined, true);
  clock.t += 25 * 60 * 60 * 1000;
  assert.equal(inbox.list().length, 0);
  inbox.raise('tls', n);
  assert.equal(inbox.unread(), 1, 'it came back: that is news');
});

test('mute until resolved: quiet now, speaks again after it resolved once; forever stays quiet', () => {
  const { inbox } = fresh();
  inbox.raise('mcp:x', { ...n, kind: 'mcp' });
  inbox.mute('mcp:x', 'until-resolved');
  inbox.raise('mcp:x', { ...n, kind: 'mcp' });
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.muted().length, 1);
  inbox.resolve('mcp:x');
  inbox.raise('mcp:x', { ...n, kind: 'mcp' });
  assert.equal(inbox.list().length, 1);
  inbox.mute('mcp:x', 'forever');
  inbox.resolve('mcp:x');
  inbox.raise('mcp:x', { ...n, kind: 'mcp' });
  assert.equal(inbox.list().length, 0);
  inbox.unmute('mcp:x');
  assert.equal(inbox.list().length, 1);
});

test('the file is owner-only and survives a restart', () => {
  const { inbox, path } = fresh();
  inbox.raise('config', { ...n, kind: 'config' });
  inbox.saveNow();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 1);
  assert.equal(new Inbox(path).list()[0]!.key, 'config');
});

test('log: REM must fail three runs in a row, a finished run clears it', () => {
  const { inbox } = fresh();
  for (let i = 1; i < FAIL_STREAK; i++) inboxFromLog(inbox, { msg: 'dream.failed_chunks', agent: 'ada' });
  assert.equal(inbox.list().length, 0, 'two failures are the log\'s business');
  inboxFromLog(inbox, { msg: 'dream.failed_chunks', agent: 'ada' });
  assert.match(inbox.list()[0]!.title, /REM keeps failing for ada/);
  inboxFromLog(inbox, { msg: 'dream.completed', agent: 'ada' });
  assert.ok(inbox.list()[0]!.resolvedAt);
  inboxFromLog(inbox, { msg: 'dream.failed_chunks', agent: 'ada' });
  assert.equal(inbox.list().filter((e) => !e.resolvedAt).length, 0, 'the streak starts over');
});

test('log: a Deep note failing three runs is one entry; its answer resolves it', () => {
  const { inbox } = fresh();
  for (let i = 0; i < 5; i++) inboxFromLog(inbox, { msg: 'dream.deep.llm_call_failed', agent: 'ada', slug: 'long-note', err: 'Claude Code process aborted by user' });
  const e = inbox.list();
  assert.equal(e.length, 1);
  assert.match(e[0]!.title, /long-note/);
  assert.equal(e[0]!.count, 3);
  inboxFromLog(inbox, { msg: 'dream.deep.llm_response', agent: 'ada', slug: 'long-note', op: 'deep', engine: 'claude-cli' });
  assert.ok(inbox.list()[0]!.resolvedAt);
});

test('log: a login error opens a notice at once, the next good turn on that engine closes it; other errors do not', () => {
  const { inbox } = fresh();
  inboxFromLog(inbox, { msg: 'engine.fail', engine: 'codex-cli', err: 'connection reset' });
  assert.equal(inbox.list().length, 0);
  inboxFromLog(inbox, { msg: 'engine.fail', engine: 'claude-cli', err: 'Invalid API key · Please run /login' });
  assert.match(inbox.list()[0]!.title, /Claude wants a new login/);
  inboxFromLog(inbox, { msg: 'engine.turn', engine: 'claude-cli' });
  assert.ok(inbox.list()[0]!.resolvedAt);
});

test('log: an OpenAI compatible refusal is per provider; another provider answering does not close it', () => {
  const { inbox } = fresh();
  inboxFromLog(inbox, { msg: 'turn.engine_init', turnId: 't1', provider: 'cloud', engine: 'openai-compatible' });
  inboxFromLog(inbox, { msg: 'engine.fail', engine: 'openai-compatible', err: '401 Invalid API key' });
  inboxFromLog(inbox, { msg: 'turn.engine_error', turnId: 't1', engine: 'openai-compatible', err: '401 Invalid API key' });
  const e = inbox.list();
  assert.equal(e.length, 1, 'engine.fail without a provider adds nothing');
  assert.equal(e[0]!.key, 'login:openai-compatible:cloud');
  assert.match(e[0]!.text, /providers\.cloud\.apiKey/);
  inboxFromLog(inbox, { msg: 'engine.turn', engine: 'openai-compatible', provider: 'local' });
  assert.equal(inbox.list()[0]!.resolvedAt, undefined);
  inboxFromLog(inbox, { msg: 'engine.turn', engine: 'openai-compatible', provider: 'cloud' });
  assert.ok(inbox.list()[0]!.resolvedAt);
});

test('log: certificate and Lucid', () => {
  const { inbox } = fresh();
  inboxFromLog(inbox, { msg: 'server.tls.renew_failed', days_left: 5, hint: 'run tailscale cert', err: 'denied' });
  inboxFromLog(inbox, { msg: 'dream.lucid.run_interrupted' });
  assert.deepEqual(inbox.list().map((e) => e.key).sort(), ['lucid', 'tls']);
  inboxFromLog(inbox, { msg: 'server.tls.reloaded' });
  inboxFromLog(inbox, { msg: 'dream.lucid.done' });
  assert.equal(inbox.list().filter((e) => !e.resolvedAt).length, 0);
});

test('state: a lost tool-server login is one notice with the login to run', () => {
  const { inbox, clock } = fresh();
  const src = state({
    mcpServers: () => ({ design: { state: 'needs-auth', loginHint: 'Run the design login.', lastError: 'refresh rejected (HTTP 400)' } }),
  });
  for (let i = 0; i < 5; i++) inboxFromState(inbox, src, clock.t + i * 300_000);
  const open = inbox.list().filter((e) => !e.resolvedAt);
  assert.equal(open.length, 1);
  assert.match(open[0]!.text, /Run the design login\./);
});

const state = (over: Partial<InboxStateSources> = {}): InboxStateSources => ({
  version: '2026.1012.6',
  update: () => ({ updateAvailable: false, latestVersion: '2026.1012.6', note: null, enabled: true }),
  configProblem: () => null,
  mcpServers: () => ({}),
  unavailableModels: () => [],
  ...over,
});

test('log: a paused Sentinel check is one entry per trigger; its next check after a resume, or deleting it, closes it', () => {
  const { inbox } = fresh();
  inboxFromLog(inbox, { msg: 'sentinel.check.paused', triggerId: 'gpu-wait-x1', name: 'gpu wait', agent: 'ada', kind: 'error', reason: '3 check errors in a row. Last: exit code 7' });
  inboxFromLog(inbox, { msg: 'sentinel.check.paused', triggerId: 'mail-y2', name: 'mail', agent: 'ada', kind: 'cap', reason: '24 wake-ups today' });
  const [cap, err] = [inbox.list().find((e) => e.key === 'sentinel:mail-y2')!, inbox.list().find((e) => e.key === 'sentinel:gpu-wait-x1')!];
  assert.equal(err.kind, 'sentinel');
  assert.equal(err.level, 'warning');
  assert.match(err.title, /gpu wait/);
  assert.match(err.text, /exit code 7/);
  assert.equal(cap.level, 'info');
  assert.match(cap.title, /until tomorrow/);
  inboxFromLog(inbox, { msg: 'sentinel.check.resumed', triggerId: 'gpu-wait-x1' });
  inboxFromLog(inbox, { msg: 'sentinel.trigger.deleted', triggerId: 'mail-y2' });
  assert.equal(inbox.list().every((e) => e.resolvedAt !== undefined), true);
});

test('state: an update, then the next one replaces it; the same note is never two entries', () => {
  const { inbox } = fresh();
  inboxFromState(inbox, state({ update: () => ({ updateAvailable: true, latestVersion: '2026.1013.1', note: 'Hello', enabled: true }) }));
  inboxFromState(inbox, state({ update: () => ({ updateAvailable: true, latestVersion: '2026.1013.1', note: 'Hello', enabled: true }) }));
  assert.deepEqual(inbox.list().map((e) => e.kind).sort(), ['news', 'update']);
  inboxFromState(inbox, state({ update: () => ({ updateAvailable: true, latestVersion: '2026.1013.2', note: 'Hello', enabled: true }) }));
  const open = inbox.list().filter((e) => !e.resolvedAt);
  assert.deepEqual(open.map((e) => e.key).sort(), ['news:' + open.find((e) => e.kind === 'news')!.key.slice(5), 'update:2026.1013.2'].sort());
  assert.equal(open.find((e) => e.kind === 'update')!.url, 'https://github.com/thenaxon/somora_agent/releases/tag/v2026.1013.2');
});

test('state: a broken config is a notice and goes when fixed', () => {
  const { inbox } = fresh();
  inboxFromState(inbox, state({ configProblem: () => ({ since: 1, message: 'server.port: expected number' }) }));
  assert.match(inbox.list()[0]!.text, /server\.port/);
  inboxFromState(inbox, state());
  assert.ok(inbox.list()[0]!.resolvedAt);
});

test('state: a tool server or model counts only after a day; a lost login at once', () => {
  const { inbox, clock } = fresh();
  const src = state({
    mcpServers: () => ({ off: { state: 'failed', lastError: 'ECONNREFUSED' }, auth: { state: 'needs-auth' } }),
    unavailableModels: () => [{ ref: 'p/m', reason: '500 connection error' }],
  });
  inboxFromState(inbox, src, clock.t);
  assert.deepEqual(inbox.list().map((e) => e.key), ['login:mcp:auth']);
  clock.t += GONE_FOR_MS + 1;
  inboxFromState(inbox, src, clock.t);
  assert.deepEqual(inbox.list().map((e) => e.key).sort(), ['login:mcp:auth', 'mcp:off', 'model:p/m']);
  inboxFromLog(inbox, { msg: 'model.available_again', model: 'p/m' });
  inboxFromState(inbox, state({ mcpServers: () => ({ off: { state: 'connected' }, auth: { state: 'connected' } }) }), clock.t);
  assert.equal(inbox.list().filter((e) => !e.resolvedAt).length, 0);
});

test('a state checked again and again is one condition: no counting', () => {
  const { inbox } = fresh();
  const src = state({ configProblem: () => ({ since: 1, message: 'broken' }) });
  for (let i = 0; i < 5; i++) inboxFromState(inbox, src);
  assert.equal(inbox.list()[0]!.count, 1);
});
