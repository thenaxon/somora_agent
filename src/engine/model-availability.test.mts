// Run: npx tsx src/engine/model-availability.test.mts
import assert from 'node:assert/strict';
import { configureModelAvailability, listUnavailableModels, markModelAvailable, markModelUnavailable, modelUnavailable, resetModelAvailability, unavailableReason } from './model-availability.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

resetModelAvailability();
configureModelAvailability(60);
const t0 = 1_000_000_000_000;
check('unknown model has no mark', modelUnavailable('p/a', t0) === null);
const e = markModelUnavailable('p/a', '500 litellm ... Connection error', t0);
check('mark carries since/until/reason', e.since === t0 && e.until === t0 + 60 * 60_000 && /Connection error/.test(e.reason));
check('mark is visible inside the window', modelUnavailable('p/a', t0 + 59 * 60_000) !== null);
check('mark expires after the window and is dropped', modelUnavailable('p/a', t0 + 61 * 60_000) === null && modelUnavailable('p/a', t0 + 61 * 60_000) === null);
markModelUnavailable('p/a', 'again', t0);
markModelUnavailable('p/a', 'still', t0 + 30 * 60_000);
const renewed = modelUnavailable('p/a', t0 + 31 * 60_000)!;
check('a renewed mark keeps the first since and extends until', renewed.since === t0 && renewed.until === t0 + 90 * 60_000, JSON.stringify(renewed));
check('reason line names the time', /not tried — marked unavailable since \d\d:\d\d: still/.test(unavailableReason(renewed)), unavailableReason(renewed));
check('a success drops the mark', markModelAvailable('p/a') === true && modelUnavailable('p/a', t0) === null && markModelAvailable('p/a') === false);
markModelUnavailable('p/a', 'x', t0);
markModelUnavailable('p/b', 'y', t0 + 1000);
check('list is oldest first and skips expired', listUnavailableModels(t0 + 2000).map((m) => m.ref).join(',') === 'p/a,p/b' && listUnavailableModels(t0 + 2 * 60 * 60_000).length === 0);
markModelUnavailable('p/a', 'x', t0);
configureModelAvailability(1);
markModelUnavailable('p/c', 'z', t0);
check('ttl follows the config', modelUnavailable('p/c', t0 + 61_000) === null && modelUnavailable('p/a', t0 + 61_000) !== null);
check('reset clears everything', resetModelAvailability() >= 1 && listUnavailableModels(t0).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
