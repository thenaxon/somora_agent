// rem.fallback as a chain: the run walks primary → backup 1 → backup 2
// when each is unreachable (Rene, 2026-09-26). Run: npx tsx src/dream/rem-fallback-chain.test.mts
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-rem-chain-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.SOMORA_HOME = home;
const { extractFromSession } = await import('./rem-extract.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

// One good backend; the unreachable ones are closed ports.
const good = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content: JSON.stringify([{ action: 'memory_write', slug: 'chain-fact', proposed_content: 'The chain works.', reason: 'test' }]) } }] }));
  });
});
await new Promise<void>((r) => good.listen(0, '127.0.0.1', r));
const goodPort = (good.address() as AddressInfo).port;
const closedPort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
const model = (id: string, port: number) =>
  ({ providerName: 'fake', modelId: id, provider: { engine: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', maxRetries: 0 }, model: { id, contextWindow: 200_000 } }) as never;

const switches: Array<{ from: string; to: string; atChunk: number }> = [];
const result = await extractFromSession({
  agent: 'testagent',
  events: [{ ts: 1000, kind: 'user_message', text: 'remember the chain fact' }] as never[],
  existingMemory: [],
  referencedVault: [],
  workerModel: model('primary', await closedPort()),
  fallbackModels: [model('backup-1', await closedPort()), model('backup-2', goodPort)],
  chunkTimeoutMs: 20_000,
  chunkTokens: 50_000,
  onWorkerSwitch: async (sw: { from: string; to: string; atChunk: number }) => { switches.push(sw); },
} as never);

check('the run completed on the last backup', result.completed === true && result.failedChunks === 0, JSON.stringify({ completed: result.completed, failed: result.failedChunks }));
check('the finding came from the good backend', result.findings.some((f: { slug: string }) => f.slug === 'chain-fact'), JSON.stringify(result.findings));
check('two switches, in chain order', switches.length === 2 && switches[0]!.from === 'fake/primary' && switches[0]!.to === 'fake/backup-1' && switches[1]!.from === 'fake/backup-1' && switches[1]!.to === 'fake/backup-2', JSON.stringify(switches));
check('the result names the final switch', result.workerSwitch?.to === 'fake/backup-2', JSON.stringify(result.workerSwitch));

// chain exhausted → the chunk fails, nothing hangs
const switches2: unknown[] = [];
const r2 = await extractFromSession({
  agent: 'testagent',
  events: [{ ts: 1000, kind: 'user_message', text: 'remember the chain fact' }] as never[],
  existingMemory: [],
  referencedVault: [],
  workerModel: model('primary', await closedPort()),
  fallbackModels: [model('backup-1', await closedPort())],
  chunkTimeoutMs: 20_000,
  chunkTokens: 50_000,
  onWorkerSwitch: async (sw: unknown) => { switches2.push(sw); },
} as never);
check('exhausted chain: chunk fails, one switch recorded', r2.failedChunks === 1 && switches2.length === 1, JSON.stringify({ failed: r2.failedChunks, switches: switches2.length }));

await new Promise<void>((r) => good.close(() => r()));
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
