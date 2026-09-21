// Lucid: a run that read nothing is FAILED, not "completed, 0 findings".
//
// Run: npx tsx src/dream/lucid-coverage.test.mts
//
// Before 2026-09-21 a subfolder whose LLM call errored was skipped, an
// unreadable answer parsed to [], an abort broke out of the loop — and
// all three ended in setRunStatus('completed'). The live logs held 35
// failed subfolder calls (an expired OAuth session took out whole runs)
// that the weekly audit booked as a clean wiki.
//
// Covered: all batches erroring → failed; all unreadable → failed;
// abort → failed; some failing → completed with batches_failed; healthy
// → completed, counters 0; object + trailing prose is read, not failed.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `somora-lucid-cov-test-${process.pid}`);
process.env.SOMORA_HOME = HOME;
const VAULT = join(HOME, 'vault');
for (const [sub, page] of [['personen', 'anna'], ['projekte', 'haus']] as const) {
  mkdirSync(join(VAULT, 'somora', sub), { recursive: true });
  writeFileSync(join(VAULT, 'somora', sub, `${page}.md`), `# ${page}\n\nSome body text about ${page}.\n`);
}
writeFileSync(join(VAULT, 'somora', 'index.md'), '# Index\n- [[personen/anna]]\n- [[projekte/haus]]\n');

const { ConfigSchema } = await import('../config/types.ts');
const { runLucid, parseLucidFindings } = await import('./lucid-runner.ts');
const { readLucidRunById } = await import('./lucid-storage.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const FINDING = {
  kind: 'dead_ref',
  affected_pages: ['personen/anna'],
  reason: 'links to a page that does not exist',
  proposed_fix: { kind: 'no_op' },
};
const GOOD = JSON.stringify({ findings: [FINDING] });

// Per request: what to answer. 'error' = HTTP 400 (no retry), 'hang' = never.
let script: Array<string | 'error' | 'hang'> = [];
let requests = 0;
const hanging: import('node:http').ServerResponse[] = [];
const server = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    const step = script[Math.min(requests, script.length - 1)]!;
    requests++;
    if (step === 'hang') {
      hanging.push(res);
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (step === 'error') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'bad request (test)' } }));
      return;
    }
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: step } }] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

const config = ConfigSchema.parse({
  providers: {
    fake: {
      engine: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'x',
      models: [{ id: 'fake-model', alias: 'fakeworker', contextWindow: 100000 }],
    },
  },
  obsidian: { vault: VAULT },
  wiki: { lucid: { model: 'fakeworker' } },
});

async function run(steps: typeof script, signal?: AbortSignal) {
  script = steps;
  requests = 0;
  const result = await runLucid({ config, trigger: 'manual', ...(signal ? { signal } : {}) });
  const stored = await readLucidRunById(result.runId);
  return { result, stored };
}

// 2 subfolders + cross pass = 3 batches.
{
  const { result, stored } = await run([GOOD, '{"findings": []}', '{"findings": []}']);
  check('healthy: completed', result.status === 'completed', result.status);
  check('healthy: one finding', result.findingsCount === 1, `${result.findingsCount}`);
  check('healthy: 3 batches, 0 failed', stored?.batches_total === 3 && stored?.batches_failed === 0, `${stored?.batches_total}/${stored?.batches_failed}`);
  check('healthy: stored completed', stored?.status === 'completed');
}
{
  const { result, stored } = await run(['error']);
  check('all error: failed', result.status === 'failed', result.status);
  check('all error: stored failed + error text', stored?.status === 'failed' && /all 3 batch/.test(stored?.error ?? ''), stored?.error);
  check('all error: no completed_at', stored?.completed_at === undefined);
}
{
  const { result, stored } = await run(['I could not find anything wrong.', '{"findings": [', '{"notfindings": 1}']);
  check('all unreadable: failed', result.status === 'failed', result.status);
  check('all unreadable: 3/3 failed', stored?.batches_failed === 3, `${stored?.batches_failed}`);
}
{
  const { result, stored } = await run(['error', GOOD, '{"findings": []}']);
  check('partial: completed', result.status === 'completed', result.status);
  check('partial: finding kept', result.findingsCount === 1);
  check('partial: batches_failed=1 of 3', stored?.batches_total === 3 && stored?.batches_failed === 1, `${stored?.batches_total}/${stored?.batches_failed}`);
}
{
  const { result } = await run([GOOD + '\n\nLet me know if you want more detail.', '{"findings": []}', '{"findings": []}']);
  check('trailing prose: completed, finding read', result.status === 'completed' && result.findingsCount === 1, `${result.status}/${result.findingsCount}`);
}
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const { result, stored } = await run([GOOD, 'hang'], ac.signal);
  check('abort: failed, not completed', result.status === 'failed', result.status);
  check('abort: error says aborted', /aborted/.test(stored?.error ?? ''), stored?.error);
  check('abort: partial finding kept for audit', (stored?.findings.length ?? 0) === 1, `${stored?.findings.length}`);
  for (const r of hanging.splice(0)) r.destroy();
}
{
  check('parse: [] findings is readable', Array.isArray(parseLucidFindings('{"findings": []}', 't')));
  check('parse: prose is null', parseLucidFindings('nothing', 't') === null);
  check('parse: cut off is null', parseLucidFindings('{"findings": [{"kind": "dead_ref", "rea', 't') === null);
}

server.close();
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
