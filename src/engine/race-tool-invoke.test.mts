// Regression tests for stop-button tool abort (s9).
//
// Run: npx tsx src/engine/race-tool-invoke.test.mts
//
// Protects: user AbortSignal ends a hanging tool wait immediately
// instead of waiting out the full tool timeout. Timeout still returns
// an error-shaped result so the model can retry.

import { raceToolInvoke } from './openai-compatible.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Toolish =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

const timeoutResult: Toolish = { ok: false, error: 'timed out' };

{
  // Timeout path: hanging invoke → timeoutResult, does not reject.
  const started = Date.now();
  const hang: Promise<Toolish> = delay(5_000).then(() => ({ ok: true, data: 'late' }));
  const result = await raceToolInvoke(hang, {
    timeoutMs: 40,
    timeoutResult,
  });
  const elapsed = Date.now() - started;
  check('timeout resolves error shape', result.ok === false && result.error === 'timed out');
  check('timeout is fast', elapsed < 500, `elapsed=${elapsed}`);
}

{
  // Abort path: hanging invoke + abort → AbortError well before timeout.
  const ac = new AbortController();
  const started = Date.now();
  const hang: Promise<Toolish> = delay(5_000).then(() => ({ ok: true, data: 'late' }));
  const pending = raceToolInvoke(hang, {
    timeoutMs: 10_000,
    signal: ac.signal,
    timeoutResult,
  });
  setTimeout(() => ac.abort(), 30);
  let rejected: unknown;
  try {
    await pending;
  } catch (err) {
    rejected = err;
  }
  const elapsed = Date.now() - started;
  check(
    'abort rejects AbortError',
    rejected instanceof DOMException && rejected.name === 'AbortError',
    String(rejected),
  );
  check('abort is fast (not full tool timeout)', elapsed < 500, `elapsed=${elapsed}`);
}

{
  // Already-aborted signal rejects immediately.
  const ac = new AbortController();
  ac.abort();
  let rejected: unknown;
  try {
    const hang: Promise<Toolish> = delay(100).then(() => ({ ok: true }));
    await raceToolInvoke(hang, {
      timeoutMs: 5_000,
      signal: ac.signal,
      timeoutResult,
    });
  } catch (err) {
    rejected = err;
  }
  check(
    'pre-aborted signal rejects immediately',
    rejected instanceof DOMException && rejected.name === 'AbortError',
    String(rejected),
  );
}

{
  // Happy path: invoke wins before timeout/abort.
  const done: Promise<Toolish> = Promise.resolve({ ok: true, data: 42 });
  const result = await raceToolInvoke(done, {
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    timeoutResult,
  });
  check('invoke success passes through', result.ok === true && result.data === 42);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
