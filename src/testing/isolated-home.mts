// A home of its own, or nothing. Import FIRST in any test that writes
// into SOMORA_HOME.
//
// Why this exists, plainly: on 2026-09-12 a test of mine wrote fixture
// personas for "hans" and "lisa" into the configured home. Run through
// scripts/run-tests.mjs that is a throwaway directory and harmless. Run
// straight with `npx tsx src/…/x.test.mts` — which is what the header
// of every test file invites you to do — SOMORA_HOME is unset, the
// default is the operator's real `~/.somora`, and two live agents lost
// their persona and their agent.yaml. They were restored from backups;
// the voice block, added the day before, was younger than the newest
// backup and had to be reconstructed by hand.
//
// The lesson is not "remember to set the variable". It is that a test
// must not be able to reach the real installation at all. So:
//
//   - no SOMORA_HOME           → a temp one is created and used
//   - SOMORA_HOME already set  → trusted, unless it IS the real home
//   - SOMORA_HOME = ~/.somora  → refuse to run, loudly
//
// Ordering is load-bearing. `src/server/logger.ts` resolves the home and
// opens its log file at import time, and anything that imports it
// inherits that decision. ESM evaluates imports in source order, so this
// line has to come before every other src import — and modules that read
// the home at load time have to be pulled in dynamically, after it.
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const realHome = join(homedir(), '.somora');
const configured = process.env.SOMORA_HOME;

if (configured && resolve(configured) === realHome) {
  throw new Error(
    `refusing to run: SOMORA_HOME points at the live installation (${realHome}). ` +
      'Tests write fixtures into it. Unset the variable and a throwaway home is made for you.',
  );
}

if (!configured) {
  const home = mkdtempSync(join(tmpdir(), 'somora-test-'));
  process.env.SOMORA_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude-home');
}

export const ISOLATED_HOME = process.env.SOMORA_HOME!;
