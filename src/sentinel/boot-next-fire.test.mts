// An `every` trigger across restarts (Fable review 2026-11-10 Nr. 4):
// the boot keeps a stored fire that is still ahead and otherwise steps on
// from the last scheduled one — it used to move it to now + interval on
// every start, so "every 12h" never fired on a day with more restarts.
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootNextFire } from './scheduler.ts';
import type { Trigger } from './types.ts';

const H = 3600_000;
const now = Date.parse('2026-11-10T20:00:00Z');
const every12 = (extra: Partial<Trigger>): Trigger =>
  ({
    id: 't-ab12',
    name: 't',
    status: 'active',
    createdAt: new Date(now - 30 * H).toISOString(),
    source: { type: 'time', spec: { type: 'every', interval: '12h' } },
    dispatch: { agent: 'ada', prompt: 'x' },
    ...extra,
  }) as unknown as Trigger;

test('a stored next fire still ahead is kept across a restart', () => {
  const due = new Date(now + 2 * H).toISOString();
  assert.equal(bootNextFire(every12({ nextFireAt: due }), now)?.toISOString(), due);
});

test('ten restarts before the fire is due do not push it out', () => {
  let t = every12({ nextFireAt: new Date(now + 3 * H).toISOString() });
  for (let i = 0; i < 10; i++) {
    const next = bootNextFire(t, now + i * 15 * 60_000)!;
    t = { ...t, nextFireAt: next.toISOString() };
  }
  assert.equal(t.nextFireAt, new Date(now + 3 * H).toISOString());
});

test('a missed fire (server was down) lands on the next slot of the old rhythm, not now + 12h', () => {
  const missed = now - 5 * H; // was due 5 h ago
  const next = bootNextFire(every12({ nextFireAt: new Date(missed).toISOString() }), now)!;
  assert.equal(next.getTime(), missed + 12 * H);
});

test('daily triggers keep their own clock', () => {
  const t = { ...every12({}), source: { type: 'time', spec: { type: 'daily', time: '09:00' } } } as unknown as Trigger;
  const next = bootNextFire(t, now)!;
  assert.ok(next.getTime() > now && next.getTime() <= now + 24 * H);
});
