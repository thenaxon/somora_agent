// Tests for listLucidRuns control-file + shape robustness (2026-07-23).
//
// Run: npx tsx src/dream/lucid-storage.test.mts
//
// Regression (Gideon report): dream_review's control file `loop-state.json`
// lives in the same directory as the run JSONs. listLucidRuns read every
// *.json as a LucidRun, so the control file (no `findings[]`) became a
// pseudo-run and `dream_list` crashed on `r.findings.length` for EVERY
// agent whenever any review loop was open. Fix: skip loop-state.json +
// shape-guard on `findings`.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point SOMORA_HOME at a temp dir BEFORE importing the module (which
// computes LUCID_ROOT from process.env.SOMORA_HOME at load time).
const HOME = join(tmpdir(), `somora-lucid-test-${process.pid}`);
process.env.SOMORA_HOME = HOME;
const LUCID = join(HOME, 'wiki-lucid');
mkdirSync(LUCID, { recursive: true });

// A valid run.
writeFileSync(
  join(LUCID, '20260723-120000_run.json'),
  JSON.stringify({ id: '20260723-120000_run', status: 'pending', findings: [{ id: 1 }, { id: 2 }] }),
);
// The control file — the exact crasher.
writeFileSync(join(LUCID, 'loop-state.json'), JSON.stringify({ lastStartedAt: null }));
// Foreign JSON without a findings array (defense-in-depth case).
writeFileSync(join(LUCID, 'garbage.json'), JSON.stringify({ foo: 'bar' }));

const { listLucidRuns } = await import('./lucid-storage.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

let runs: Awaited<ReturnType<typeof listLucidRuns>> = [];
let threw = false;
try {
  runs = await listLucidRuns();
} catch (err) {
  threw = true;
  console.error('listLucidRuns threw:', (err as Error).message);
}

check('does not throw with a control file present', !threw);
check('returns exactly the one real run', runs.length === 1, `${runs.length}`);
check(
  'loop-state control file is not returned as a run',
  !runs.some((r) => (r as unknown as { lastStartedAt?: unknown }).lastStartedAt !== undefined),
);
check('garbage.json (no findings[]) is skipped', !runs.some((r) => r.id === undefined));
// The exact operation that crashed dream_list must now be safe on every result.
let lenOk = true;
for (const r of runs) {
  if (!Array.isArray(r.findings)) lenOk = false;
  else void r.findings.length; // would have thrown pre-fix on the control file
}
check('every returned run has an array findings (r.findings.length safe)', lenOk);
check('valid run findings preserved', runs[0]?.findings.length === 2, `${runs[0]?.findings.length}`);

rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
