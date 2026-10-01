#!/usr/bin/env node
// Test launcher. Every test runs against a throwaway SOMORA_HOME, so a
// test can never write into the live installation's logs, sessions or
// memory (2026-09-08 report: fallback tests left `level:50` lines in
// ~/.somora/logs and made "0 errors since restart" meaningless).
//
// The isolation has to be in place BEFORE any test file is imported:
// src/server/logger.ts resolves SOMORA_HOME and opens its log file at
// import time. Setting it here, in the parent, covers static imports,
// child processes a test spawns, and harnesses started by hand through
// this script.
//
// Usage:
//   npm test                     all *.test.mts under src/
//   npm test src/browser         only that subtree
//   npm test -- --test-name-pattern=handoff
//
// SOMORA_TEST_HOME=/some/dir keeps the home (and its logs) after the run
// for inspection; otherwise it is removed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const patterns = args.filter((a) => !a.startsWith('-'));
const flags = args.filter((a) => a.startsWith('-'));
const globs = patterns.length
  ? patterns.map((p) => (/\.m?tsx?$/.test(p) ? p : `${p.replace(/\/$/, '')}/**/*.test.mts`))
  : ['src/**/*.test.mts'];

const keep = Boolean(process.env.SOMORA_TEST_HOME);
const home = process.env.SOMORA_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'somora-test-'));

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...flags, ...globs],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SOMORA_HOME: home,
      // The claude-cli engine and anything spawning `claude` must not
      // read or write the developer's real Claude config either.
      CLAUDE_CONFIG_DIR: join(home, 'claude-home'),
      SOMORA_LOG_LEVEL: process.env.SOMORA_LOG_LEVEL ?? 'warn',
    },
  },
);

const cleanup = () => {
  if (keep) {
    console.log(`test home kept: ${home}`);
    return;
  }
  // pino-roll writes asynchronously; a failed removal is not a failed
  // test run, so report it and move on.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (err) {
    console.warn(`could not remove test home ${home}: ${(err instanceof Error ? err.message : String(err))}`);
  }
};

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
