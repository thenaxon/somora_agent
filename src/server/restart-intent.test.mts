import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allowResume, clearRestartIntent, detectedResumeText, looksLikeSelfRestart, readRestartIntent, requestedResumeText,
  turnRestartedServer, writeRestartIntent,
} from './restart-intent.ts';
import { openTurnOf, restartParentWakeText, restartWakeText } from './restart-reconcile.ts';

test('commands that restart this somora are recognised, others are not', () => {
  for (const yes of [
    'somora server restart',
    'cd /srv && somora update',
    'somora update 2026.1005.1 --no-reinit',
    'systemctl --user restart somora.service',
    'sudo systemctl restart somora',
    'launchctl kickstart -k gui/501/ai.somora.server',
    'launchctl bootout gui/501/ai.somora.server && launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.somora.server.plist',
    'pm2 restart somora',
  ]) assert.equal(looksLikeSelfRestart(yes), true, yes);
  for (const no of [
    'systemctl --user status somora.service',
    'systemctl --user restart caddy',
    'somora server status',
    'somora telemetry show',
    'journalctl --user -u somora -n 50',
    'systemctl restart nginx; echo somora',
  ]) assert.equal(looksLikeSelfRestart(no), false, no);
});

test('a turn is marked when one of its tool calls restarted the server', () => {
  assert.equal(turnRestartedServer([{ kind: 'tool_call', tool: 'exec', input: { command: 'npm run build && systemctl --user restart somora.service' } }]), true);
  assert.equal(turnRestartedServer([{ kind: 'tool_call', tool: 'tmux', input: { keys: ['somora update', 'Enter'] } }]), true);
  assert.equal(turnRestartedServer([{ kind: 'tool_call', tool: 'exec', input: { command: 'ls' } }, { kind: 'assistant_message', text: 'systemctl restart somora' }]), false);
  const cut = openTurnOf([
    { kind: 'user_message', ts: 1, text: 'deploy it' },
    { kind: 'turn_start', ts: 2, turnId: 't-1' },
    { kind: 'tool_call', ts: 3, tool: 'exec', input: { command: 'systemctl --user restart somora' } },
  ])!;
  assert.equal(cut.selfRestart, true);
  const other = openTurnOf([{ kind: 'user_message', ts: 1 }, { kind: 'turn_start', ts: 2, turnId: 't-2' }, { kind: 'tool_call', ts: 3, tool: 'exec', input: { command: 'make' } }])!;
  assert.equal(other.selfRestart, undefined);
  // a restart command in an EARLIER, finished turn does not mark the cut one
  const later = openTurnOf([
    { kind: 'turn_start', ts: 1, turnId: 't-0' }, { kind: 'tool_call', ts: 2, tool: 'exec', input: { command: 'somora update' } }, { kind: 'turn_end', ts: 3, turnId: 't-0' },
    { kind: 'user_message', ts: 4 }, { kind: 'turn_start', ts: 5, turnId: 't-3' },
  ])!;
  assert.equal(later.selfRestart, undefined);
});

test('the request survives on disk and is read back once', () => {
  assert.equal(readRestartIntent(), null);
  writeRestartIntent({ agent: 'ada', session: '20261004-100000_deploy', requestedAt: 1000, fromVersion: '2026.1002.1', reason: 'somora update → 2026.1004.1' });
  assert.deepEqual(readRestartIntent(), { agent: 'ada', session: '20261004-100000_deploy', requestedAt: 1000, fromVersion: '2026.1002.1', reason: 'somora update → 2026.1004.1' });
  clearRestartIntent();
  assert.equal(readRestartIntent(), null);
  clearRestartIntent(); // twice is fine
});

test('wake texts say what happened and forbid restarting again', () => {
  const t = requestedResumeText({ agent: 'ada', session: 's', requestedAt: 1000, fromVersion: '2026.1002.1', reason: 'somora update → 2026.1004.1' }, '2026.1004.1', 13_000);
  assert.match(t, /restart you requested is done: somora 2026\.1002\.1 → 2026\.1004\.1, back after 12 s \(somora update → 2026\.1004\.1\)/);
  assert.match(t, /do not restart again/);
  assert.match(requestedResumeText({ agent: 'a', session: 's', requestedAt: 0, fromVersion: '1.2.3' }, '1.2.3', 500), /somora 1\.2\.3, back after 1 s\./);
  assert.match(detectedResumeText('2026.1004.1'), /do NOT run it again/);
  // all restart messages carry the system lead-in the clients read the occasion from
  for (const text of [t, detectedResumeText('1.0.0'), restartWakeText({ agent: 'bea', session: 's', turnId: 't', startedAt: 0, callId: 'c1' }), restartParentWakeText({ agent: 'bea', session: 's', turnId: 't', startedAt: 0 })]) {
    assert.match(text, /^\[system: restart\] /);
  }
});

test('a session is woken at most twice in ten minutes', () => {
  const t0 = 1_000_000_000;
  assert.equal(allowResume('loop', 'main', t0), true);
  assert.equal(allowResume('loop', 'main', t0 + 60_000), true);
  assert.equal(allowResume('loop', 'main', t0 + 120_000), false, 'third within the window');
  assert.equal(allowResume('other', 'main', t0 + 120_000), true, 'another session is unaffected');
  assert.equal(allowResume('loop', 'main', t0 + 11 * 60_000), true, 'after the window the first has aged out');
});
