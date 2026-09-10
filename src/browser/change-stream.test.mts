import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrowserSnapshots } from './change-stream.ts';

test('snapshot stream coalesces changes during a slow send and restores latest state', async () => {
  let changed!: () => void;
  let release!: () => void;
  let current = 1;
  let unsubscribed = false;
  const sent: number[] = [];
  const stop = watchBrowserSnapshots({
    subscribe: (fn) => { changed = fn; return () => { unsubscribed = true; }; },
    read: async () => current,
    send: async (n) => { sent.push(n); if (n === 1) await new Promise<void>((r) => { release = r; }); },
    failed: (e) => { throw e; },
  });
  await new Promise((r) => setImmediate(r));
  for (let n = 2; n <= 100; n++) { current = n; changed(); }
  assert.deepEqual(sent, [1]);
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [1, 100]);
  stop();
  changed();
  assert.equal(unsubscribed, true);
  assert.deepEqual(sent, [1, 100]);
});

test('disconnect during snapshot read sends no late state', async () => {
  let resolve!: (n: number) => void;
  const sent: number[] = [];
  const stop = watchBrowserSnapshots({ subscribe: () => () => {}, read: () => new Promise<number>((r) => { resolve = r; }), send: async (n) => { sent.push(n); }, failed: () => assert.fail() });
  stop(); resolve(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, []);
});
