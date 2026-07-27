// Tests for skill-scoped env injection (2026-07-27).
//
// Run: npx tsx src/skills/env-scope.test.mts
//
// Design (gog friction report + Rene's decision): env vars declared by
// any skill are stripped from exec children by default; a command that
// visibly invokes a skill's declared bin gets exactly that skill's vars
// re-injected. Token-scan (not first-token-only) so compound commands
// match.

import assert from 'node:assert/strict';

import { computeSkillEnvScope, extractCommandBins } from './env-scope.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const SKILLS = [
  { name: 'gog', requiresBins: ['gog'], requiresEnvVars: ['GOG_KEYRING_PASSWORD', 'GOG_ACCOUNT'] },
  { name: 'op-vault', requiresBins: ['op'], requiresEnvVars: ['OP_SERVICE_ACCOUNT_TOKEN'] },
  { name: 'no-env-skill', requiresBins: ['jq'], requiresEnvVars: [] },
  { name: 'no-bins-skill', requiresBins: [], requiresEnvVars: ['ORPHAN_SECRET'] },
];

const ENV = {
  GOG_KEYRING_PASSWORD: 'gog-pass',
  GOG_ACCOUNT: 'cornelia@siegl.at',
  OP_SERVICE_ACCOUNT_TOKEN: 'op-token',
  ORPHAN_SECRET: 'orphan',
  UNRELATED: 'stay',
};

// ── extractCommandBins ────────────────────────────────────────────────
{
  const t = extractCommandBins('cd ~/x && /home/linuxbrew/.linuxbrew/bin/gog drive search');
  check('tokenizes compound command', t.has('gog') && t.has('cd'));
  check('basename of absolute path', t.has('gog'));
  const q = extractCommandBins('"gog" auth add');
  check('strips quotes', q.has('gog'));
  const p = extractCommandBins('GOG_DEBUG=1 gog sync | tee log');
  check('env-prefix + pipe', p.has('gog') && p.has('tee'));
}

// ── plain skill command → its vars injected, others stripped ─────────
{
  const s = computeSkillEnvScope('gog drive search "quarterly report"', SKILLS, ENV);
  check('matched gog', s.matchedSkills.length === 1 && s.matchedSkills[0] === 'gog');
  check('gog vars injected', s.injectEnv.GOG_KEYRING_PASSWORD === 'gog-pass' && s.injectEnv.GOG_ACCOUNT === 'cornelia@siegl.at');
  check('op var NOT injected', !('OP_SERVICE_ACCOUNT_TOKEN' in s.injectEnv));
  check(
    'strip set covers all declared vars',
    s.stripVars.includes('OP_SERVICE_ACCOUNT_TOKEN') &&
      s.stripVars.includes('GOG_KEYRING_PASSWORD') &&
      s.stripVars.includes('ORPHAN_SECRET'),
  );
  check('unrelated var untouched', !s.stripVars.includes('UNRELATED'));
}

// ── unrelated command → nothing injected, everything stripped ────────
{
  const s = computeSkillEnvScope('ls -la /tmp', SKILLS, ENV);
  check('no match', s.matchedSkills.length === 0);
  check('nothing injected', Object.keys(s.injectEnv).length === 0);
  check('still strips all declared', s.stripVars.length === 4);
}

// ── compound command matches ─────────────────────────────────────────
{
  const s = computeSkillEnvScope('cd ~/somoraworkspace && gog sheets export --id 42', SKILLS, ENV);
  check('compound matched', s.matchedSkills.includes('gog'));
}

// ── absolute-path invocation matches via basename ────────────────────
{
  const s = computeSkillEnvScope('/home/linuxbrew/.linuxbrew/bin/gog auth doctor', SKILLS, ENV);
  check('abs-path matched', s.matchedSkills.includes('gog'));
}

// ── two skills in one command → both injected ────────────────────────
{
  const s = computeSkillEnvScope('op read secret | gog drive upload -', SKILLS, ENV);
  check('both matched', s.matchedSkills.length === 2);
  check('both injected', s.injectEnv.OP_SERVICE_ACCOUNT_TOKEN === 'op-token' && s.injectEnv.GOG_KEYRING_PASSWORD === 'gog-pass');
}

// ── bin-name as substring does NOT match (word-boundary via tokens) ──
{
  const s = computeSkillEnvScope('cat gogol.txt && echo gog-report.md', SKILLS, ENV);
  check('substring no match', s.matchedSkills.length === 0, JSON.stringify(s.matchedSkills));
}

// ── declared var missing from env → skipped, not empty-string ────────
{
  const s = computeSkillEnvScope('gog sync', SKILLS, { GOG_ACCOUNT: 'x' });
  check('missing value skipped', !('GOG_KEYRING_PASSWORD' in s.injectEnv) && s.injectEnv.GOG_ACCOUNT === 'x');
}

// ── skill without declared env vars never matters ────────────────────
{
  const s = computeSkillEnvScope('jq . file.json', SKILLS, ENV);
  check('env-less skill no injection', s.matchedSkills.length === 0);
}

// ── no skills declare anything → fully inert ─────────────────────────
{
  const s = computeSkillEnvScope('gog sync', [{ name: 'x', requiresBins: ['gog'], requiresEnvVars: [] }], ENV);
  check('inert without declarations', s.stripVars.length === 0 && Object.keys(s.injectEnv).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
