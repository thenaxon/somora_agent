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
//   npm test                     all *.test.mts under src/, web/src and web-mobile/src
//   npm test src/browser         only that subtree (web/src/lib for the web client)
//   npm test -- --test-name-pattern=handoff
//
// SOMORA_TEST_HOME=/some/dir keeps the home (and its logs) after the run
// for inspection; otherwise it is removed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const patterns = args.filter((a) => !a.startsWith('-'));
const flags = args.filter((a) => a.startsWith('-'));

// The web clients are their own TypeScript projects: a .tsx component
// compiles with the JSX setting of the tsconfig that COVERS the file, and
// the root tsconfig covers src/ only. Run from the repo root, a web test
// fell back to classic JSX and died with "React is not defined" — so
// each project runs from its own folder, with its own tsconfig in reach.
const PROJECTS = [
  { dir: '.', glob: 'src/**/*.test.mts' },
  { dir: 'web', glob: 'src/**/*.test.mts' },
  { dir: 'web-mobile', glob: 'src/**/*.test.mts' },
];

/** Group the requested patterns by project; no pattern = every project. */
function plan() {
  if (patterns.length === 0) return PROJECTS.map((p) => ({ dir: p.dir, globs: [p.glob] }));
  const byDir = new Map();
  for (const raw of patterns) {
    const p = /\.m?tsx?$/.test(raw) ? raw : `${raw.replace(/\/$/, '')}/**/*.test.mts`;
    const project = PROJECTS.slice(1).find((x) => p === x.dir || p.startsWith(`${x.dir}/`));
    const dir = project ? project.dir : '.';
    const rel = project ? p.slice(project.dir.length + 1) : p;
    byDir.set(dir, [...(byDir.get(dir) ?? []), rel]);
  }
  return [...byDir].map(([dir, globs]) => ({ dir, globs }));
}

const keep = Boolean(process.env.SOMORA_TEST_HOME);
const home = process.env.SOMORA_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'somora-test-'));
const env = {
  ...process.env,
  SOMORA_HOME: home,
  // The claude-cli engine and anything spawning `claude` must not
  // read or write the developer's real Claude config either.
  CLAUDE_CONFIG_DIR: join(home, 'claude-home'),
  SOMORA_LOG_LEVEL: process.env.SOMORA_LOG_LEVEL ?? 'warn',
};

function runProject({ dir, globs }) {
  return new Promise((done) => {
    if (dir !== '.') console.log(`\n# ${dir}/`);
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...flags, ...globs], {
      cwd: resolve(dir),
      stdio: 'inherit',
      env,
    });
    child.on('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

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

let worst = 0;
for (const step of plan()) {
  const code = await runProject(step);
  if (code !== 0) worst = code;
}
cleanup();
process.exit(worst);
