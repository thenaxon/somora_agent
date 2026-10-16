// Brakes on handing external agents work (docs/a2a.md): at most N tasks
// per agent at once, the rest wait in line and get the slot in order;
// a stop while waiting leaves the line; a lowered limit is honoured; the
// daily count survives (it lives on disk) and stops at the limit.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireSlot, dailyCalls, resetSlots, slotState, takeDailyCall } from './limits.ts';

test('two at a time; the third waits and gets the slot when one finishes', async () => {
  resetSlots();
  const a = await acquireSlot('claw', 2);
  const b = await acquireSlot('claw', 2);
  let waited = 0;
  let third = false;
  const c = acquireSlot('claw', 2, undefined, (ahead) => (waited = ahead)).then((r) => {
    third = true;
    return r;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(third, false);
  assert.equal(waited, 1);
  assert.deepEqual(slotState('claw'), { running: 2, waiting: 1 });
  // Another agent is not held up.
  const other = await acquireSlot('herm', 2);
  a();
  const releaseC = await c;
  assert.equal(third, true);
  assert.deepEqual(slotState('claw'), { running: 2, waiting: 0 }, 'the slot was handed on, not freed and retaken');
  a(); // releasing twice does nothing
  assert.deepEqual(slotState('claw'), { running: 2, waiting: 0 });
  b();
  releaseC();
  other();
  assert.deepEqual(slotState('claw'), { running: 0, waiting: 0 });
});

test('first come, first served; a stop while waiting leaves the line', async () => {
  resetSlots();
  const hold = await acquireSlot('x', 1);
  const order: string[] = [];
  const ac = new AbortController();
  const p1 = acquireSlot('x', 1).then((r) => (order.push('one'), r));
  const p2 = acquireSlot('x', 1, ac.signal).then(
    (r) => (order.push('two'), r),
    (e: Error) => (order.push(`two stopped: ${e.message}`), null),
  );
  const p3 = acquireSlot('x', 1).then((r) => (order.push('three'), r));
  ac.abort();
  await p2;
  hold();
  (await p1)();
  (await p3)();
  assert.deepEqual(order, ['two stopped: stopped while waiting for a free slot', 'one', 'three']);
  assert.deepEqual(slotState('x'), { running: 0, waiting: 0 });
});

test('the daily count is kept on disk and stops at the limit', () => {
  rmSync(join(process.env.SOMORA_HOME!, 'a2a'), { recursive: true, force: true });
  assert.equal(dailyCalls(), 0);
  assert.deepEqual(takeDailyCall(2), { ok: true, count: 1 });
  assert.deepEqual(takeDailyCall(2), { ok: true, count: 2 });
  assert.deepEqual(takeDailyCall(2), { ok: false, count: 2 }, 'nothing counted past the limit');
  assert.equal(dailyCalls(), 2);
  assert.deepEqual(takeDailyCall(5), { ok: true, count: 3 }, 'a raised limit lets more through');
});
