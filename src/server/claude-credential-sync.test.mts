// Tests for the shared-login credential content-sync (2026-07-27).
//
// Run: npx tsx src/server/claude-credential-sync.test.mts
//
// Regression (2026-07-24/25 reports): the symlink that shared
// ~/.claude/.credentials.json with somora's claude-home is destroyed by
// the CLI's rename-based token-refresh writes; afterwards both sides
// rotate the same OAuth session independently and kill each other's
// refresh-token chain (daily forced re-logins). The sync module replaces
// the symlink invariant with content reconciliation: newest `expiresAt`
// wins, loser is overwritten atomically with a single rotating backup.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconcileCredentialPair } from './claude-credential-sync.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

function cred(expiresAt: number, marker: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${marker}`,
      refreshToken: `rt-${marker}`,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });
}

function freshDirs(): { user: string; somora: string } {
  const base = mkdtempSync(join(tmpdir(), 'cred-sync-test-'));
  return { user: join(base, 'claude', '.credentials.json'), somora: join(base, 'claude-home', '.credentials.json') };
}

function write(path: string, content: string, mtimeSec?: number): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

const cleanups: string[] = [];

// ── both missing → noop ───────────────────────────────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  check('both-missing noop', reconcileCredentialPair(user, somora) === 'noop');
}

// ── user missing (standalone install) → noop, nothing invented ───────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(somora, cred(2000, 'somora-only'));
  check('standalone noop', reconcileCredentialPair(user, somora) === 'noop');
  check('standalone user-side untouched', !existsSync(user));
}

// ── somora missing → bootstrap pull ──────────────────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(3000, 'user'));
  check('bootstrap pulled', reconcileCredentialPair(user, somora) === 'pulled');
  check('bootstrap content', readFileSync(somora, 'utf8') === cred(3000, 'user'));
  const mode = statSync(somora).mode & 0o777;
  check('bootstrap mode 0600', mode === 0o600, `got ${mode.toString(8)}`);
}

// ── identical → noop ─────────────────────────────────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(3000, 'same'));
  write(somora, cred(3000, 'same'));
  check('identical noop', reconcileCredentialPair(user, somora) === 'noop');
}

// ── diverged, user expiresAt newer → pulled + backup of loser ────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(5000, 'user-new'));
  write(somora, cred(4000, 'somora-old'));
  check('user-newer pulled', reconcileCredentialPair(user, somora) === 'pulled');
  check('user-newer content', readFileSync(somora, 'utf8') === cred(5000, 'user-new'));
  check('user-newer backup', readFileSync(`${somora}.somora-prev`, 'utf8') === cred(4000, 'somora-old'));
  check('user-newer src untouched', readFileSync(user, 'utf8') === cred(5000, 'user-new'));
}

// ── diverged, somora expiresAt newer → pushed back into user side ────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(4000, 'user-old'));
  write(somora, cred(6000, 'somora-new'));
  check('somora-newer pushed', reconcileCredentialPair(user, somora) === 'pushed');
  check('somora-newer content', readFileSync(user, 'utf8') === cred(6000, 'somora-new'));
  check('somora-newer backup', readFileSync(`${user}.somora-prev`, 'utf8') === cred(4000, 'user-old'));
}

// ── corrupt somora side loses even with newer mtime (Lucy nulled-file) ─
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(5000, 'user'), 1000);
  write(somora, '\0\0\0\0', 2000); // corrupt AND newer mtime
  check('corrupt-somora pulled', reconcileCredentialPair(user, somora) === 'pulled');
  check('corrupt-somora healed', readFileSync(somora, 'utf8') === cred(5000, 'user'));
}

// ── corrupt user side loses → pushed ─────────────────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, '{broken', 2000);
  write(somora, cred(5000, 'somora'), 1000);
  check('corrupt-user pushed', reconcileCredentialPair(user, somora) === 'pushed');
  check('corrupt-user healed', readFileSync(user, 'utf8') === cred(5000, 'somora'));
}

// ── both unparseable → mtime decides ─────────────────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, 'garbage-a', 2000); // newer
  write(somora, 'garbage-b', 1000);
  check('both-corrupt mtime pulled', reconcileCredentialPair(user, somora) === 'pulled');
  check('both-corrupt content', readFileSync(somora, 'utf8') === 'garbage-a');
}

// ── equal expiresAt, different content → mtime tie-break ─────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(5000, 'user-tie'), 1000);
  write(somora, cred(5000, 'somora-tie'), 2000); // somora newer mtime
  check('tie pushed by mtime', reconcileCredentialPair(user, somora) === 'pushed');
  check('tie content', readFileSync(user, 'utf8') === cred(5000, 'somora-tie'));
}

// ── backup rotates, no timestamped-file accumulation ─────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(5000, 'v1'));
  write(somora, cred(4000, 'old-1'));
  reconcileCredentialPair(user, somora);
  write(user, cred(7000, 'v2'));
  write(somora, cred(6000, 'old-2'));
  reconcileCredentialPair(user, somora);
  check('rotating backup latest', readFileSync(`${somora}.somora-prev`, 'utf8') === cred(6000, 'old-2'));
  const files = readdirSync(join(somora, '..'));
  check('no backup accumulation', files.length === 2, `got ${files.join(',')}`);
}

// ── reconcile is idempotent (second pass no-ops) ─────────────────────
{
  const { user, somora } = freshDirs();
  cleanups.push(join(user, '..', '..'));
  write(user, cred(5000, 'idem'));
  write(somora, cred(4000, 'stale'));
  check('idempotent first pulled', reconcileCredentialPair(user, somora) === 'pulled');
  check('idempotent second noop', reconcileCredentialPair(user, somora) === 'noop');
}

for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
