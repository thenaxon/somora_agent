// tool-output: full copies of shortened results, swept after 7 days.
// Run: npx tsx src/tools/tool-output.test.mts (needs SOMORA_HOME set to
// a throwaway dir — scripts/run-tests.mjs does that)
import assert from 'node:assert/strict';
import { readFile, stat, utimes } from 'node:fs/promises';
import { saveToolOutput, sweepToolOutput, toolOutputDir, TOOL_OUTPUT_RETENTION_MS } from './tool-output.ts';

const agent = 'test-agent';
const file = await saveToolOutput(agent, 'exec-stdout', 'hello\nworld\n');
assert.ok(file && file.startsWith(toolOutputDir(agent)), String(file));
assert.equal(await readFile(file!, 'utf8'), 'hello\nworld\n');

// fresh file survives a sweep
assert.equal(await sweepToolOutput([agent]), 0);
await stat(file!);

// an old file is removed
const old = new Date(Date.now() - TOOL_OUTPUT_RETENTION_MS - 60_000);
await utimes(file!, old, old);
assert.equal(await sweepToolOutput([agent]), 1);
await assert.rejects(stat(file!));

// unknown agent dir is not an error
assert.equal(await sweepToolOutput(['nobody-here']), 0);
console.log('tool-output.test: ok');
