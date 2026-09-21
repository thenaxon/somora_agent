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

// ── /reset archives are read ONCE (2026-09-21) ──────────────────────
// The reset path runs its own dream over the archive it just made. It
// never stamped the marker, so the idle worker — which reads archived
// sessions since .10.03 — dreamed every reset archive a second time.

const { dreamArchivedAfterReset } = await import('./rem-reset-run.ts');
const { writeDreamFile } = await import('./storage.ts');
const { resetSession } = await import('../storage/sessions.ts');

async function sessionWithOneMessage(agent: string, slug: string, ts = Date.now()): Promise<string> {
  const id = await createSession(agent, slug);
  await appendEvent(agent, id, { kind: 'user_message', ts, engine: 'openai-compatible', text: `note in ${slug}` } as never);
  return id;
}

function dreamMeta(id: string, source: string, status: string) {
  return {
    meta: {
      id,
      status,
      source_session: source,
      created_at: new Date().toISOString(),
      trigger: 'auto',
      worker_model_ref: 'fake/fake',
      range_from_ts: 0,
      range_through_ts: Date.now(),
      findings: [],
      ...(status === 'failed' ? { error: 'boom' } : {}),
    } as never,
    body: status,
  };
}

test('a reset archive is stamped after a successful run and is not work again', async () => {
  const agent = 'resetter';
  const worker = new RemWorker({ config: {} as never, getMemoryManager: (async () => ({})) as never });
  const id = await sessionWithOneMessage(agent, 'main-like');
  const reset = await resetSession(agent, id);
  assert.ok(reset, 'reset archived the session');
  assert.equal(await worker.workRemaining(agent), true, 'the fresh archive is unread');

  const seen: Array<{ from: number; through: number; session: string }> = [];
  const out = await dreamArchivedAfterReset({
    agent,
    archivedId: reset!.archivedId,
    rem: {} as never,
    config: {} as never,
    mgr: {} as never,
    runDreamImpl: (async (a: { rangeFromTs: number; rangeThroughTs: number; sourceSession: string }) => {
      seen.push({ from: a.rangeFromTs, through: a.rangeThroughTs, session: a.sourceSession });
      return { id: 'd1', finalStatus: 'processed' };
    }) as never,
  });
  assert.equal(out.stamped, true);
  assert.equal(seen[0]!.session, reset!.archivedId);
  const meta = await sessionMetaStore.get(agent, reset!.archivedId);
  assert.equal(meta.dreamReadThroughTs, seen[0]!.through, 'stamped with the range end captured before the run');
  assert.equal(await worker.workRemaining(agent), false, 'the idle worker has nothing left to read here');
});

test('a FAILED reset run leaves the archive for the idle worker', async () => {
  const agent = 'resetter-failed';
  const worker = new RemWorker({ config: {} as never, getMemoryManager: (async () => ({})) as never });
  const id = await sessionWithOneMessage(agent, 'main-like');
  const reset = await resetSession(agent, id);
  for (const status of ['failed', 'paused']) {
    const out = await dreamArchivedAfterReset({
      agent,
      archivedId: reset!.archivedId,
      rem: {} as never,
      config: {} as never,
      mgr: {} as never,
      runDreamImpl: (async () => ({ id: 'd', finalStatus: status })) as never,
    });
    assert.equal(out.stamped, false, `${status} must not stamp`);
  }
  assert.equal((await sessionMetaStore.get(agent, reset!.archivedId)).dreamReadThroughTs, undefined);
  assert.equal(await worker.workRemaining(agent), true, 'still work — nothing was lost');
});

test('the reset run starts where idle REM stopped, and never rewinds the marker', async () => {
  const agent = 'resetter-range';
  const id = await sessionWithOneMessage(agent, 'main-like');
  const meta0 = await sessionMetaStore.get(agent, id);
  await sessionMetaStore.set(agent, id, { ...meta0, dreamReadThroughTs: 4242 });
  const reset = await resetSession(agent, id);
  let from = -1;
  await dreamArchivedAfterReset({
    agent,
    archivedId: reset!.archivedId,
    rem: {} as never,
    config: {} as never,
    mgr: {} as never,
    runDreamImpl: (async (a: { rangeFromTs: number }) => {
      from = a.rangeFromTs;
      // Someone else advanced the marker far ahead while we ran.
      const m = await sessionMetaStore.get(agent, reset!.archivedId);
      await sessionMetaStore.set(agent, reset!.archivedId, { ...m, dreamReadThroughTs: Date.now() + 3_600_000 });
      return { id: 'd', finalStatus: 'completed' };
    }) as never,
  });
  assert.equal(from, 4242, 'only the unread tail is dreamed');
  const after = await sessionMetaStore.get(agent, reset!.archivedId);
  assert.ok((after.dreamReadThroughTs as number) > Date.now() + 3_000_000, 'max() — never rewound');
});

// ── session selection (2026-09-21) ──────────────────────────────────

test('a session with a dream in flight is not picked a second time', async () => {
  const agent = 'selector-inflight';
  const worker = new RemWorker({ config: {} as never, getMemoryManager: (async () => ({})) as never });
  const id = await sessionWithOneMessage(agent, 'busy');
  assert.equal(await worker.workRemaining(agent), true);
  await writeDreamFile(agent, dreamMeta('run-1', id, 'running'));
  assert.equal(await worker.workRemaining(agent), false, 'the running dream owns that session');
});

test('a session whose last attempt failed goes to the back, not the front', async () => {
  const agent = 'selector-failed';
  const worker = new RemWorker({ config: {} as never, getMemoryManager: (async () => ({})) as never });
  const pick = (): Promise<{ id: string } | null> =>
    (worker as unknown as { findSessionWithDelta(a: string): Promise<{ id: string } | null> }).findSessionWithDelta(agent);

  const older = await sessionWithOneMessage(agent, 'older', Date.now() - 60_000);
  await new Promise((r) => setTimeout(r, 15));
  const newest = await sessionWithOneMessage(agent, 'newest');
  assert.equal((await pick())?.id, newest, 'newest first while nothing has failed');

  await writeDreamFile(agent, dreamMeta('fail-1', newest, 'failed'));
  assert.equal((await pick())?.id, older, 'the failing newest no longer blocks the older one');

  // Once the older one is read, the failed one is retried — it is
  // deferred, not dropped.
  const m = await sessionMetaStore.get(agent, older);
  await sessionMetaStore.set(agent, older, { ...m, dreamReadThroughTs: Date.now() + 60_000 });
  assert.equal((await pick())?.id, newest, 'deferred, not forgotten');
  assert.equal(await worker.workRemaining(agent), true);
});
