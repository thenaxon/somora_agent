// A REM cycle picks its work from disk before a run exists. The dream
// switch turned off — or the user writing — during that pick used to
// find no run to abort, and the run started anyway (review 2026-10-17).
//
// Run: npm test src/dream/rem-cycle-race.test.mts

import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RemWorker } = await import('./rem-worker.ts');

/** A worker whose session pick waits for `release`, counting runs. */
function gatedWorker() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let picking!: () => void;
  const picked = new Promise<void>((r) => (picking = r));
  let runs = 0;
  const worker = new RemWorker({
    config: {} as never,
    getMemoryManager: (async () => ({})) as never,
    runDreamImpl: (async () => {
      runs++;
      return { status: 'completed' };
    }) as never,
  });
  const w = worker as unknown as Record<string, unknown>;
  w.findPausedDream = async () => null;
  w.findSessionWithDelta = async () => {
    picking();
    await gate;
    return { id: 'a-session', dreamReadThroughTs: 0 };
  };
  w.workRemaining = async () => false;
  // Fire by hand instead of waiting for the idle timer — and drop that
  // timer, which fireIdle would otherwise leave running.
  const fire = (agent: string) => {
    const state = (w.agents as Map<string, { idleTimer: NodeJS.Timeout | null }>).get(agent)!;
    clearTimeout(state.idleTimer!);
    return (w.fireIdle as (a: string) => Promise<void>).call(worker, agent);
  };
  return { worker, fire, release, picked, runs: () => runs };
}

const rem = { idleMinutes: 60, model: 'fake/fake' } as never;

test('switching dreams off while the cycle picks its session: no run', async () => {
  const g = gatedWorker();
  g.worker.register('dreamer', rem);
  const cycle = g.fire('dreamer');
  await g.picked;
  g.worker.unregister('dreamer');
  g.release();
  await cycle;
  assert.equal(g.runs(), 0);
  await g.worker.shutdown();
});

test('the user writing while the cycle picks its session: no run', async () => {
  const g = gatedWorker();
  g.worker.register('dreamer', rem);
  const cycle = g.fire('dreamer');
  await g.picked;
  g.worker.resetActivity('dreamer');
  g.release();
  await cycle;
  assert.equal(g.runs(), 0);
  await g.worker.shutdown();
});

test('left alone, the cycle runs', async () => {
  const g = gatedWorker();
  g.worker.register('dreamer', rem);
  const cycle = g.fire('dreamer');
  await g.picked;
  g.release();
  await cycle;
  assert.ok(g.runs() >= 1);
  await g.worker.shutdown();
});
