// Tests for skill-bin version constraints + duplicate detection
// (2026-07-27, gog friction report §3.4 — the v0.12/v0.34 split-brain).
//
// Run: npx tsx src/skills/bin-checks.test.mts

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkBinRequirement,
  compareVersions,
  findAllBinPaths,
  getBinVersion,
  parseBinRequirement,
  resetBinCheckCaches,
  satisfiesConstraint,
} from './bin-checks.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── parseBinRequirement ───────────────────────────────────────────────
check('bare name', JSON.stringify(parseBinRequirement('gog')) === JSON.stringify({ bin: 'gog' }));
check(
  '>= constraint',
  JSON.stringify(parseBinRequirement('gog>=0.30')) ===
    JSON.stringify({ bin: 'gog', constraint: { op: '>=', version: '0.30' } }),
);
check(
  'spaces tolerated',
  JSON.stringify(parseBinRequirement('gog >= 0.30')) ===
    JSON.stringify({ bin: 'gog', constraint: { op: '>=', version: '0.30' } }),
);
check(
  'exact ==',
  parseBinRequirement('jq==1.7').constraint?.op === '==' && parseBinRequirement('jq==1.7').bin === 'jq',
);
check('dotted bin name', parseBinRequirement('foo.sh').bin === 'foo.sh');

// ── compareVersions / satisfiesConstraint ─────────────────────────────
check('0.34.1 > 0.30', compareVersions('0.34.1', '0.30') === 1);
check('0.12.0 < 0.30', compareVersions('0.12.0', '0.30') === -1);
check('1.2 == 1.2.0', compareVersions('1.2', '1.2.0') === 0);
check('10.0 > 9.9', compareVersions('10.0', '9.9') === 1, 'numeric not lexical');
check('satisfies >=', satisfiesConstraint('0.34.1', { op: '>=', version: '0.30' }));
check('violates >=', !satisfiesConstraint('0.12.0', { op: '>=', version: '0.30' }));
check('satisfies <', satisfiesConstraint('0.9', { op: '<', version: '1.0' }));

// ── real fake binaries in tmp dirs ────────────────────────────────────
const dirA = mkdtempSync(join(tmpdir(), 'bin-check-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'bin-check-b-'));
function fakeBin(dir: string, name: string, version: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} version ${version}"\n`);
  chmodSync(p, 0o755);
  return p;
}
const oldGog = fakeBin(dirA, 'fakegog', '0.12.0');
fakeBin(dirB, 'fakegog', '0.34.1');
fakeBin(dirB, 'solo', '2.1.0');

const savedPath = process.env.PATH;
process.env.PATH = `${dirA}:${dirB}`;
resetBinCheckCaches();

// getBinVersion parses the fake output
check('version parsed', (await getBinVersion(oldGog)) === '0.12.0');

// findAllBinPaths sees both copies, PATH order first
{
  const paths = await findAllBinPaths('fakegog');
  check('two copies found', paths.length === 2, JSON.stringify(paths));
  check('PATH order first', paths[0] === join(dirA, 'fakegog'));
}

// duplicate → warning, first copy governs the constraint (0.12 loses)
{
  const r = await checkBinRequirement('fakegog>=0.30');
  check('constraint fails on active copy', !r.ok);
  check('reason names version+path', (r.reason ?? '').includes('0.12.0') && (r.reason ?? '').includes(dirA));
  check('duplicate warning present', r.warnings.some((w) => w.includes('multiple installs')));
  check('warning lists both versions', r.warnings.some((w) => w.includes('0.12.0') && w.includes('0.34.1')));
}

// single healthy bin with satisfied constraint
{
  const r = await checkBinRequirement('solo>=2.0');
  check('solo ok', r.ok);
  check('solo no warnings', r.warnings.length === 0, JSON.stringify(r.warnings));
}

// bare-name entry with duplicates → ok but warned
{
  const r = await checkBinRequirement('fakegog');
  check('bare ok despite duplicates', r.ok);
  check('bare still warns', r.warnings.length === 1);
}

// missing bin
{
  const r = await checkBinRequirement('definitely-not-here-xyz');
  check('missing not ok', !r.ok && (r.reason ?? '').includes('missing bin'));
}

process.env.PATH = savedPath;
resetBinCheckCaches();
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
