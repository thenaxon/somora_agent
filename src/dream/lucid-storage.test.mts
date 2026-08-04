// Tests for pendingLucidSummary — the /dream-states lucid review-
// backlog fields (2026-07-29 feedback: pending lucid runs were
// invisible in every client because the API had no pending field).
//
// Run: npx tsx src/dream/lucid-storage.test.mts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'somora-lucid-'));
process.env.SOMORA_HOME = HOME;

// Dynamic import AFTER SOMORA_HOME is set (module reads it at load).
const { pendingLucidSummary } = await import('./lucid-storage.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const LUCID = join(HOME, 'wiki-lucid');
mkdirSync(join(LUCID, 'processed'), { recursive: true });

function writeRun(
  id: string,
  status: string,
  findingStatuses: string[],
  createdAt: string,
  processed = false,
): void {
  const run = {
    id,
    status,
    created_at: createdAt,
    trigger: 'auto',
    pages_scanned: 10,
    worker_model_ref: 'test',
    findings: findingStatuses.map((s, i) => ({
      id: i + 1,
      status: s,
      kind: 'stale',
      page: `wissen/p${i}`,
      description: 'x',
    })),
  };
  const dir = processed ? join(LUCID, 'processed') : LUCID;
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(run, null, 2));
}

// Empty dir → zeros, no oldestPendingAt.
{
  const s = await pendingLucidSummary();
  check('empty: zero runs', s.pendingRuns === 0);
  check('empty: zero findings', s.pendingFindings === 0);
  check('empty: no oldestPendingAt', s.oldestPendingAt === undefined);
}

// Mixed population — mirrors the real 2026-07-27 case (21 findings).
writeRun('20260727-201844_auto_lucid', 'completed', Array(21).fill('pending'), '2026-07-27T20:18:44Z');
writeRun('20260730-090000_auto_lucid', 'completed', ['pending', 'applied', 'pending'], '2026-07-30T09:00:00Z');
writeRun('20260731-100000_manual_lucid', 'running', [], '2026-07-31T10:00:00Z');
writeRun('20260725-080000_auto_lucid', 'failed', [], '2026-07-25T08:00:00Z');
writeRun('20260720-070000_auto_lucid', 'processed', ['applied'], '2026-07-20T07:00:00Z', true);
// The review-loop control file shares the dir — must not crash/count.
writeFileSync(join(LUCID, 'loop-state.json'), JSON.stringify({ agent: 'x' }));

{
  const s = await pendingLucidSummary();
  check('counts completed runs only', s.pendingRuns === 2, String(s.pendingRuns));
  check(
    'sums only pending findings (21 + 2, applied excluded)',
    s.pendingFindings === 23,
    String(s.pendingFindings),
  );
  check(
    'oldestPendingAt is the oldest completed run',
    s.oldestPendingAt === '2026-07-27T20:18:44Z',
    s.oldestPendingAt ?? 'undefined',
  );
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
