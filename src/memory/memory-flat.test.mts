// Tests for flat-memory classification (2026-07-23).
//
// Run: npx tsx src/memory/memory-flat.test.mts
//
// Regression (Juni-Audit): notes in a memory SUBDIRECTORY got a `sub--note`
// slug the read/write/delete API can't address (it reconstructs a flat
// `sub--note.md` path), so memory_write on such a slug created a colliding
// second file. Decision: memory is flat — only files directly under
// memoryRoot are memory notes; subdir files are ignored. classifySource
// gates both the reindex walk and the watcher via isFlatMemoryFile.

import assert from 'node:assert/strict';

import { isFlatMemoryFile } from './manager.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const ROOT = '/home/u/.somora/agents/hans/memory';

check('flat note directly under root → true', isFlatMemoryFile(`${ROOT}/rene.md`, ROOT) === true);
check('one-level subdir note → false', isFlatMemoryFile(`${ROOT}/notes/x.md`, ROOT) === false);
check('deep subdir note → false', isFlatMemoryFile(`${ROOT}/notes/sub/x.md`, ROOT) === false);
check('dot-dir file (.dreams) → false', isFlatMemoryFile(`${ROOT}/.dreams/d.json`, ROOT) === false);
check('the root itself → false', isFlatMemoryFile(ROOT, ROOT) === false);
check('path outside root → false', isFlatMemoryFile('/home/u/.somora/agents/hans/other/x.md', ROOT) === false);
check(
  'sibling dir with shared prefix → false (not memoryRoot)',
  isFlatMemoryFile('/home/u/.somora/agents/hans/memory-archive/x.md', ROOT) === false,
);
check('flat note with hyphens/underscores → true', isFlatMemoryFile(`${ROOT}/rene-hardware_2026.md`, ROOT) === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
