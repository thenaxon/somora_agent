// Image jobs: a model whose endpoint offers create → status → content gets
// its image that way, with the same request body the sync call carries;
// everything else keeps the sync request (docs/imagegen.md).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'imagegen-jobs-test');
mkdirSync(process.env.SOMORA_HOME, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { clearCatalogCache } = await import('../media/capabilities.ts');
const { generateImage, setImageJobPollMs } = await import('./generate.ts');
setImageJobPollMs(5);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ASYNC = { create: '/img/create', status: '/img/status?id=', content: '/img/content?id=' };

// ─── a stand-in provider: catalog, sync endpoint and job routes ─────────

interface Seen { method: string; url: string; contentType: string; body: string }
let seen: Seen[] = [];
let catalogAsync: unknown = ASYNC;
/** Status answers in order; the last one repeats. */
let statuses: Array<Record<string, unknown> | number> = [];
let contentAnswers: number[] = [];
let syncAnswer: { status: number; body: unknown } = { status: 200, body: { data: [{ b64_json: PNG.toString('base64') }] } };
let createAnswer: Record<string, unknown> = { id: 'img_1', status: 'queued' };

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    const url = req.url!;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.endsWith('/images/models')) {
      json(200, { data: [{ id: 'qwen-x', ...(catalogAsync ? { async: catalogAsync } : {}) }] });
      return;
    }
    seen.push({ method: req.method!, url, contentType: String(req.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('latin1') });
    if (url.includes('/images/generations') || url.includes('/images/edits')) {
      json(syncAnswer.status, syncAnswer.body);
    } else if (req.method === 'POST') {
      json(200, createAnswer);
    } else if (url.includes('/status') || /\/jobs\/[^/]+$/.test(url)) {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (typeof next === 'number') json(next, { error: 'nope' });
      else json(200, { id: 'img_1', ...next });
    } else if (url.includes('/content') || url.endsWith('/file')) {
      const code = contentAnswers.shift() ?? 200;
      if (code !== 200) json(code, { error: 'not ready' });
      else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      }
    } else json(404, {});
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

beforeEach(() => {
  seen = [];
  catalogAsync = ASYNC;
  statuses = [{ status: 'completed' }];
  contentAnswers = [];
  syncAnswer = { status: 200, body: { data: [{ b64_json: PNG.toString('base64') }] } };
  createAnswer = { id: 'img_1', status: 'queued' };
  clearCatalogCache();
});

function config(model: Record<string, unknown> = {}, extraModels: Array<Record<string, unknown>> = [], imageGen: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    providers: { p: { engine: 'openai-compatible', baseUrl: base, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
    imageGen: {
      enabled: true,
      outputDir: join(process.env.SOMORA_HOME!, 'img'),
      ...imageGen,
      models: [{ name: 'qwen', provider: 'p', model: 'qwen-x', wire: 'openai', endpoint: '/images/generations', ...model }, ...extraModels],
    },
  });
}

const ref = { bytes: PNG, mime: 'image/png', filename: 'a.png' };

test('a catalog async block sends the sync body to create, polls status, fetches content', async () => {
  // The body the sync call would send, for comparison.
  await generateImage({ prompt: 'a red boat', specs: { size: '1024x1024', seed: 3 } }, config({ lifecycle: 'sync' }));
  const syncBody = seen[0]!.body;
  assert.equal(seen[0]!.url, '/v1/images/generations');

  seen = [];
  statuses = [{ status: 'queued', waiting_for_gpu: true }, { status: 'in_progress' }, { status: 'completed', warnings: ['ratio adjusted'], ignored_params: ['seed'] }];
  const out = await generateImage({ prompt: 'a red boat', specs: { size: '1024x1024', seed: 3 } }, config());
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
    'POST /v1/img/create',
    'GET /v1/img/status?id=img_1',
    'GET /v1/img/status?id=img_1',
    'GET /v1/img/status?id=img_1',
    'GET /v1/img/content?id=img_1',
  ]);
  assert.equal(seen[0]!.body, syncBody, 'create carries exactly the sync body');
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0]!.mime, 'image/png');
  const w = out.warnings ?? [];
  assert.ok(w.includes('ratio adjusted'), 'warnings from the status answer reach the caller');
  assert.ok(w.some((x) => x.includes('ignored these parameters') && x.includes('seed')));
});

test('reference images go to create as the same multipart parts as the edit call', async () => {
  await generateImage({ prompt: 'p', references: [ref, ref] }, config({ lifecycle: 'sync' }));
  const edit = seen[0]!;
  assert.equal(edit.url, '/v1/images/edits');
  seen = [];
  await generateImage({ prompt: 'p', references: [ref, ref] }, config());
  assert.equal(seen[0]!.url, '/v1/img/create');
  assert.ok(seen[0]!.contentType.startsWith('multipart/form-data'));
  const strip = (s: Seen) => s.body.replace(new RegExp(s.contentType.split('boundary=')[1]!.replace(/[-]/g, '\\-'), 'g'), 'B');
  assert.equal(strip(seen[0]!), strip(edit), 'same parts, same order, same bytes');
});

test('lifecycle: sync keeps the sync request even when the catalog offers jobs; allow does not read the catalog', async () => {
  await generateImage({ prompt: 'p' }, config({ lifecycle: 'sync' }));
  assert.deepEqual(seen.map((s) => s.url), ['/v1/images/generations']);
  seen = [];
  await generateImage({ prompt: 'p' }, config({ allow: { maxN: 1 } }));
  assert.deepEqual(seen.map((s) => s.url), ['/v1/images/generations']);
});

test('configured job paths work without a catalog; {id} is filled in; jobs without paths is a config error', async () => {
  catalogAsync = null;
  await generateImage({ prompt: 'p' }, config({ jobs: { create: '/jobs', status: '/jobs/{id}', content: '/jobs/{id}/file' } }));
  assert.deepEqual(seen.map((s) => s.url), ['/v1/jobs', '/v1/jobs/img_1', '/v1/jobs/img_1/file']);
  await assert.rejects(generateImage({ prompt: 'p' }, config({ lifecycle: 'jobs' })), /lifecycle: jobs, but neither/);
});

test('a failed job names the reason and moves the fallback chain on', async () => {
  statuses = [{ status: 'failed', error: { code: 'oom', message: 'out of GPU memory' } }];
  await assert.rejects(generateImage({ prompt: 'p' }, config()), /failed: out of GPU memory/);
  seen = [];
  const out = await generateImage({ prompt: 'p' }, config({ fallback: 'plain' }, [{ name: 'plain', provider: 'p', model: 'other', wire: 'openai', endpoint: '/images/generations', lifecycle: 'sync' }]));
  assert.equal(out.images.length, 1);
  assert.match(out.fellBackFrom![0]!, /qwen: .*out of GPU memory/);
});

test('content 409 is waited out; status 404 and a lost job are reported', async () => {
  contentAnswers = [409, 409];
  const out = await generateImage({ prompt: 'p' }, config());
  assert.equal(out.images.length, 1);
  assert.equal(seen.filter((s) => s.url.includes('/content')).length, 3);
  statuses = [404];
  await assert.rejects(generateImage({ prompt: 'p' }, config()), /no longer knows job img_1/);
  createAnswer = { status: 'queued' };
  await assert.rejects(generateImage({ prompt: 'p' }, config()), /no job id/);
});

test('a job past jobTimeoutMs stops with a clear message', async () => {
  statuses = [{ status: 'in_progress' }];
  const t0 = Date.now();
  await assert.rejects(generateImage({ prompt: 'p' }, config({ jobTimeoutMs: 5_000 })), /did not finish within 5s\. .*job img_1, status at \/img\/status\?id=img_1 .*somora stopped waiting/);
  assert.ok(Date.now() - t0 < 8_000);
});

test('a busy GPU without a job route: the retry hint is relayed and the chain still moves on', async () => {
  catalogAsync = null;
  syncAnswer = { status: 503, body: { error: { code: 'gpu_busy', message: 'studio GPU busy' }, retry_after_seconds: 60 } };
  await assert.rejects(generateImage({ prompt: 'p' }, config()), /trying again in about 60s.*gpu_busy/s);
});

test('the image job wait defaults to 15 minutes and is configurable', () => {
  assert.equal(config().imageGen!.jobTimeoutMs, 900_000);
  assert.equal(config({}, [], { jobTimeoutMs: 600_000 }).imageGen!.jobTimeoutMs, 600_000);
  assert.throws(() => config({ jobs: { create: '/a', status: '/b' } }));
});

test('without a job route the sync request is byte for byte what it always was', async () => {
  catalogAsync = null;
  await generateImage({ prompt: 'a cat', specs: { size: '1024x1024', seed: 7, quality: 'high' }, references: [ref] }, config({ wire: 'openrouter', model: 'mod-x' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/v1/images/generations');
  assert.equal(
    seen[0]!.body,
    `{"model":"mod-x","prompt":"a cat","size":"1024x1024","seed":7,"quality":"high","input_references":[{"type":"image_url","image_url":{"url":"data:image/png;base64,${PNG.toString('base64')}"}}]}`,
  );
  seen = [];
  await generateImage({ prompt: 'a cat', references: [ref], extra: { foo: 'bar', deep: { a: 1 } } }, config({ model: 'mod-x' }));
  assert.equal(seen[0]!.url, '/v1/images/edits');
  const fd = await new Response(Buffer.from(seen[0]!.body, 'latin1'), { headers: { 'content-type': seen[0]!.contentType } }).formData();
  assert.deepEqual([...fd.keys()], ['model', 'prompt', 'foo', 'deep', 'image[]']);
  assert.equal(fd.get('deep'), '{"a":1}');
});

test('a short hand-over to the GPU is not reported; an endpoint that explains the size is not explained twice', async () => {
  statuses = [{ status: 'queued', waiting_for_gpu: true }, { status: 'completed', warnings: ['edit: output is 1x1 - the canvas follows reference image 1'] }];
  const out = await generateImage({ prompt: 'p', specs: { size: '1024x1024' } }, config());
  const w = out.warnings ?? [];
  assert.ok(!w.some((x) => x.includes('GPU was busy')), 'a wait of a few milliseconds is no news');
  assert.deepEqual(w.filter((x) => x.includes('1x1')).length, 1, 'only the endpoint\'s explanation of the size');
});
