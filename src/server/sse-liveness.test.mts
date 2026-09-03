// Run: npx tsx src/server/sse-liveness.test.mts
import assert from 'node:assert/strict';
import { startSseHeartbeat } from './sse-liveness.ts';
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') => { if (c) pass++; else { fail++; console.error('FAIL', n, d); } };
// Fake clock + interval: tick() advances time and runs the interval callback.
function harness(stream: { writeSSE: (m: any) => Promise<void> }, deadAfterMs = 60_000) {
  let t = 0; let cb: (() => void) | null = null; let cleared = false; const deaths: string[] = [];
  const stop = startSseHeartbeat(stream, {
    intervalMs: 20_000, deadAfterMs, onDead: (why, d) => deaths.push(`${why}${d ? ':' + d : ''}`),
    now: () => t,
    setInterval: ((fn: () => void) => { cb = fn; return 1 as any; }) as any,
    clearInterval: (() => { cleared = true; }) as any,
  });
  return { tick: async (ms: number) => { t += ms; cb?.(); await Promise.resolve(); await Promise.resolve(); }, deaths, stop, isCleared: () => cleared };
}
{ // healthy: writes resolve, never dead
  const h = harness({ writeSSE: async () => {} });
  for (let i = 0; i < 10; i++) await h.tick(20_000);
  check('healthy stream never declared dead', h.deaths.length === 0);
  h.stop(); check('stop clears the interval', h.isCleared());
}
{ // write rejects → dead immediately, once
  const h = harness({ writeSSE: async () => { throw new Error('EPIPE'); } });
  await h.tick(20_000); await h.tick(20_000);
  check('rejected write → write_error once', h.deaths.length === 1 && h.deaths[0]!.startsWith('write_error'), JSON.stringify(h.deaths));
}
{ // write never resolves → dead after deadAfterMs, no stacked writes
  let writes = 0;
  const h = harness({ writeSSE: () => { writes++; return new Promise(() => {}); } });
  await h.tick(20_000); // write 1 pending
  await h.tick(20_000); // 20 s pending — not yet
  check('pending 20 s → not dead yet', h.deaths.length === 0);
  await h.tick(20_000); // 40 s
  check('pending 40 s → not dead yet', h.deaths.length === 0);
  await h.tick(20_000); // 60 s
  check('pending 60 s → write_timeout', h.deaths.length === 1 && h.deaths[0]!.startsWith('write_timeout'), JSON.stringify(h.deaths));
  check('no stacked writes while one is pending', writes === 1, String(writes));
  await h.tick(20_000);
  check('dead reported only once', h.deaths.length === 1);
}
{ // after stop, nothing is reported
  const h = harness({ writeSSE: () => new Promise(() => {}) });
  await h.tick(20_000); h.stop(); await h.tick(80_000);
  check('stopped heartbeat reports nothing', h.deaths.length === 0);
}
console.log(`${pass} passed, ${fail} failed`); assert.equal(fail, 0);
