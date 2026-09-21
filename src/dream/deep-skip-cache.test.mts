// A cached skip does not stand forever.
// Run: npx tsx src/dream/deep-skip-cache.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-skip-cache-'));
const { isCachedSkip, recordSkip, bodyHash } = await import('./deep-skip-cache.ts');
const { ConfigSchema } = await import('../config/types.ts');

const DAY = 86_400_000;
const now = Date.parse('2026-09-21T12:00:00Z');
const entry = (daysAgo: number) => ({ hash: bodyHash('Anna mag Tee.'), skipped_at: new Date(now - daysAgo * DAY).toISOString(), reason: 'too thin' });

// fresh skip stands
assert.ok(isCachedSkip({ anna: entry(3) }, 'anna', 'Anna mag Tee.', 30, now));
// changed body never stands, whatever the age
assert.equal(isCachedSkip({ anna: entry(3) }, 'anna', 'Anna mag Tee und Kaffee.', 30, now), null);
// old skip: looked at again — between 30 and 37.5 days depending on the slug, never later
assert.ok(isCachedSkip({ anna: entry(29) }, 'anna', 'Anna mag Tee.', 30, now), 'not before the period is over');
assert.equal(isCachedSkip({ anna: entry(38) }, 'anna', 'Anna mag Tee.', 30, now), null, 'always after period + 25%');
// 0 = the old behaviour, a skip stands until the note changes
assert.ok(isCachedSkip({ anna: entry(900) }, 'anna', 'Anna mag Tee.', 0, now));
assert.ok(isCachedSkip({ anna: entry(900) }, 'anna', 'Anna mag Tee.', undefined, now), 'callers that pass no age keep the old behaviour');
// unreadable date → look again rather than trust it
assert.equal(isCachedSkip({ anna: { ...entry(1), skipped_at: 'gestern' } }, 'anna', 'Anna mag Tee.', 30, now), null);

// a batch skipped on one day does NOT come due on one day
const cache: Record<string, ReturnType<typeof entry>> = {};
for (let i = 0; i < 40; i++) cache[`note-${i}`] = entry(0);
const dueOn = (day: number) => Object.keys(cache).filter((s) => isCachedSkip(cache as never, s, 'Anna mag Tee.', 30, now + day * DAY) === null).length;
assert.equal(dueOn(30), 0);
assert.equal(dueOn(38), 40);
const mid = dueOn(34);
assert.ok(mid > 5 && mid < 35, `spread out, got ${mid}/40 due on day 34`);

// expired vs. changed: only a same-body, outlived skip is "expired" (the runner rations those)
{
  const { isExpiredSkip } = await import('./deep-skip-cache.ts');
  assert.ok(isExpiredSkip({ anna: entry(60) }, 'anna', 'Anna mag Tee.', 30, now));
  assert.equal(isExpiredSkip({ anna: entry(3) }, 'anna', 'Anna mag Tee.', 30, now), null, 'fresh is not expired');
  assert.equal(isExpiredSkip({ anna: entry(60) }, 'anna', 'ganz anderer Text', 30, now), null, 'a changed note is not "expired" — it is simply new');
  assert.equal(isExpiredSkip({ anna: entry(900) }, 'anna', 'Anna mag Tee.', 0, now), null, 'no expiry configured');
  assert.equal(isExpiredSkip({}, 'anna', 'Anna mag Tee.', 30, now), null);
}

// skipped again → rests for another period
const c2: Record<string, never> = {};
recordSkip(c2 as never, 'anna', 'Anna mag Tee.', 'still too thin');
assert.ok(isCachedSkip(c2 as never, 'anna', 'Anna mag Tee.', 30));

// config: default 30, 0 allowed, present when the block is omitted
assert.equal(ConfigSchema.parse({ providers: {} }).wiki.deep.skipCacheDays, 30);
assert.equal(ConfigSchema.parse({ providers: {}, wiki: { deep: { skipCacheDays: 0 } } }).wiki.deep.skipCacheDays, 0);
console.log('deep-skip-cache: all passed');
