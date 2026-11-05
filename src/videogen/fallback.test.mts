// A video model that is unavailable hands the render to its `fallback:`,
// as images do; a value the model refuses does not move on. And
// `allow.maxSeconds` refuses a longer render before anything is sent.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'videogen-fallback-test');
const home = process.env.SOMORA_HOME;
mkdirSync(home, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { startVideoJob, VideoGenError } = await import('./generate.ts');
const { readJob } = await import('./jobs.ts');

// /down/ answers 503 (a GPU box with another model loaded), /refuse/
// answers 400, everything else starts a job.
let hits: string[] = [];
const provider = createServer((req, res) => {
  req.resume().on('end', () => {
    hits.push(req.url!);
    if (req.url!.startsWith('/down/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'other model loaded' } }));
      return;
    }
    if (req.url!.startsWith('/refuse/')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad seconds' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `job-${hits.length}`, status: 'queued' }));
  });
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
const port = (provider.address() as { port: number }).port;
after(() => provider.close());

const prov = (path: string) => ({ engine: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/${path}`, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] });
const allow = { supported: ['seconds'], maxSeconds: 10 };
const config = ConfigSchema.parse({
  providers: { down: prov('down'), up: prov('up'), refuse: prov('refuse') },
  videoGen: {
    enabled: true,
    maxConcurrent: 32,
    models: [
      { name: 'gpu', provider: 'down', model: 'm', wire: 'openai', capabilitiesEndpoint: null, allow, fallback: 'cloud' },
      { name: 'cloud', provider: 'up', model: 'm', wire: 'openai', capabilitiesEndpoint: null, allow },
      { name: 'picky', provider: 'refuse', model: 'm', wire: 'openai', capabilitiesEndpoint: null, allow, fallback: 'cloud' },
      { name: 'loop-a', provider: 'down', model: 'm', wire: 'openai', capabilitiesEndpoint: null, allow, fallback: 'loop-b' },
      { name: 'loop-b', provider: 'down', model: 'm', wire: 'openai', capabilitiesEndpoint: null, allow, fallback: 'loop-a' },
    ],
  },
});

beforeEach(() => {
  hits = [];
  rmSync(join(home, 'video-jobs'), { recursive: true, force: true });
});

test('an unavailable model hands the render to its fallback, and the job says so', async () => {
  const { job } = await startVideoJob({ prompt: 'a cat', model: 'gpu' }, config);
  assert.equal(job.modelName, 'cloud');
  assert.deepEqual(hits.map((h) => h.split('/')[1]), ['down', 'up']);
  assert.match(job.warnings![0]!, /fallback model 'cloud'.*'gpu' was unavailable/);
  const saved = await readJob(job.id);
  assert.equal(saved?.fellBackFrom?.length, 1);
});

test('a refused request does not move on to the fallback', async () => {
  await assert.rejects(startVideoJob({ prompt: 'a cat', model: 'picky' }, config), (e: unknown) => e instanceof VideoGenError && e.kind === 'input');
  assert.deepEqual(hits.map((h) => h.split('/')[1]), ['refuse']);
});

test('a fallback chain that loops ends after each model once', async () => {
  await assert.rejects(startVideoJob({ prompt: 'a cat', model: 'loop-a' }, config), (e: unknown) => e instanceof VideoGenError && e.kind === 'unavailable');
  assert.equal(hits.length, 2);
});

test('allow.maxSeconds refuses a longer render before anything is sent', async () => {
  await assert.rejects(startVideoJob({ prompt: 'a cat', model: 'cloud', specs: { seconds: 12 } }, config), /at most 10 s/);
  assert.equal(hits.length, 0);
  const { job } = await startVideoJob({ prompt: 'a cat', model: 'cloud', specs: { seconds: '8' } }, config);
  assert.equal(job.modelName, 'cloud');
});
