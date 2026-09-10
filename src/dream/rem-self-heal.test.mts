// REM picks its own work back up.
//
// 2026-09-08: a range that failed was retried only if the user happened
// to keep chatting with that agent, and an archived session fell out of
// the selection entirely — so a conversation could end without ever
// reaching memory, quietly. Users assume their conversations are
// dreamed; the worker has to make that true on its own.
//
// Run: npm test src/dream/rem-self-heal.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-rem-heal-'));
const { RemWorker, selfHealFactor } = await import('./rem-worker.ts');
const { appendEvent, archiveSession, createSession, sessionMetaStore } = await import('../storage/sessions.ts');

test('the retry budget grows and then stops', () => {
  assert.deepEqual([1, 2, 3, 4].map(selfHealFactor), [1, 2, 4, 8]);
  assert.equal(selfHealFactor(5), null, 'a backend that is down all afternoon is not retried all afternoon');
  assert.equal(selfHealFactor(0), null);
});

test('an archived session with unread events is still work', async () => {
  const agent = 'dreamer';
  const worker = new RemWorker({ config: {} as never, getMemoryManager: (async () => ({})) as never });

  assert.equal(await worker.workRemaining(agent), false, 'nothing to do for an agent with no sessions');

  const id = await createSession(agent, 'a-conversation');
  await appendEvent(agent, id, {
    kind: 'user_message',
    ts: Date.now(),
    engine: 'openai-compatible',
    text: 'something worth remembering',
  } as never);
  assert.equal(await worker.workRemaining(agent), true, 'a live session with new events is work');

  // The user is done with the conversation and files it away. The
  // events are still unread by REM, so the work does not vanish.
  await archiveSession(agent, id, 'done for today');
  assert.equal((await sessionMetaStore.get(agent, id)).archived, true);
  assert.equal(await worker.workRemaining(agent), true, 'archiving is not forgetting');

  // Once REM has read through it, it stops showing up.
  const meta = await sessionMetaStore.get(agent, id);
  await sessionMetaStore.set(agent, id, { ...meta, dreamReadThroughTs: Date.now() + 60_000 });
  assert.equal(await worker.workRemaining(agent), false, 'a dreamed session is done, archived or not');
});
