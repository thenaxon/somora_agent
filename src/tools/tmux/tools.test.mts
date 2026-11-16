// The tmux tool's bookkeeping around the calls: sessions waiting for the
// caller are named in every result, and sessions the tool creates keep
// a fixed size (window-size is a window option: `-w -t =name:`).
// Own SOMORA_HOME: writes tmux origins and the attention mirror.
import '../../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmux } from './tools.ts';
import { AGENT_PANE_SIZE, fixWindowSize } from './local.ts';
import { recordTmuxOrigin } from '../../tmux/origin-store.ts';
import { writeAttentionMirror } from '../../tmux/attention.ts';

const att = (needs: boolean, state: 'ready' | 'blocked' | 'running', rule?: string) => ({ needs_attention: needs, last_event_at: 1000, last_wake_at: null, wakes_today: 0, state, ...(rule ? { rule } : {}) });

test('every result names the caller\'s other sessions that finished or wait at a dialog', async () => {
  recordTmuxOrigin({ name: 'team-a', agent: 'ada', session: 's1' });
  recordTmuxOrigin({ name: 'team-b', agent: 'ada', session: 's1' });
  recordTmuxOrigin({ name: 'team-c', target: 'box', agent: 'ada', session: 's1' });
  recordTmuxOrigin({ name: 'other', agent: 'bob', session: 's1' });
  recordTmuxOrigin({ name: 'seen', agent: 'ada', session: 's1' });
  writeAttentionMirror({ 'team-a': att(true, 'ready'), 'team-b': att(true, 'blocked', 'permission_required'), '@box/team-c': att(true, 'ready'), other: att(true, 'ready'), seen: att(false, 'ready') });
  const r = (await tmux.handler(tmux.inputSchema.parse({ action: 'capture', name: 'team-a' }) as never, { agent: 'ada', session: 's1' } as never)) as { waiting_for_you?: Array<{ name: string; target?: string; state: string }> };
  const names = (r.waiting_for_you ?? []).map((w) => `${w.target ? `${w.target}/` : ''}${w.name}:${w.state}`).sort();
  assert.deepEqual(names, ['box/team-c:ready', 'team-b:blocked'], 'not the session asked about, not another agent\'s, not one already seen');
  const w = r.waiting_for_you as unknown as Array<{ name: string; reason: string; rule?: string }>;
  assert.deepEqual(w.find((x) => x.name === 'team-b'), { ...w.find((x) => x.name === 'team-b'), reason: 'dialog', rule: 'permission_required' });
  assert.equal(w.find((x) => x.name === 'team-c')?.reason, 'finished');
  assert.equal(w.find((x) => x.name === 'team-c')?.rule, undefined);
});

test('a created session has a fixed size that attaching clients do not change', () => {
  assert.equal(AGENT_PANE_SIZE, '-x 160 -y 45');
  assert.equal(fixWindowSize('codex-1'), "tmux set-option -w -t '=codex-1:' window-size manual");
});
