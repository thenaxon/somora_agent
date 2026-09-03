#!/usr/bin/env node
// somora bin entry — exposed via package.json `bin` field.
//
// We delegate to tsx + the TS source under src/cli/somora.ts because
// somora is shipped as TS (no compile step). tsx is a runtime dep.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeUpgradeHint, satisfiesNode } from './node-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// Node version gate — runs before tsx or any dependency loads, so a
// too-old Node fails with instructions instead of a stack trace from
// somewhere inside node_modules. Requirement comes from package.json
// `engines.node` (single source, bumped with the dependencies).
try {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
  const range = pkg?.engines?.node;
  if (range && !satisfiesNode(range, process.versions.node)) {
    process.stderr.write(nodeUpgradeHint(range, process.versions.node, process.execPath));
    process.exit(1);
  }
} catch {
  // unreadable package.json — let the normal path report it
}

const tsxBin = resolve(pkgRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = resolve(pkgRoot, 'src', 'cli', 'somora.ts');
const tsconfigPath = resolve(pkgRoot, 'tsconfig.json');

if (!existsSync(tsxBin)) {
  process.stderr.write(
    `somora: tsx runtime not found at ${tsxBin}\n` +
      `Install seems incomplete. Try: npm install -g somora\n`,
  );
  process.exit(1);
}
if (!existsSync(cliEntry)) {
  process.stderr.write(`somora: cli entry not found at ${cliEntry}\n`);
  process.exit(1);
}

// Pass the absolute bin path through env so the TS CLI can write it
// into the systemd unit's ExecStart line. process.argv[1] inside tsx
// would resolve to the .ts source, not this bin entry.
const env = { ...process.env, SOMORA_BIN_PATH: fileURLToPath(import.meta.url) };

// --tsconfig points tsx at the package's bundled tsconfig (with
// jsx: react-jsx), independent of the user's cwd. Without this,
// tsx falls back to classic JSX and crashes on .tsx files.
const child = spawn(tsxBin, ['--tsconfig', tsconfigPath, cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

const fwd = (sig) => () => {
  try {
    child.kill(sig);
  } catch {
    // child already gone
  }
};
process.on('SIGTERM', fwd('SIGTERM'));
process.on('SIGINT', fwd('SIGINT'));
process.on('SIGHUP', fwd('SIGHUP'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
