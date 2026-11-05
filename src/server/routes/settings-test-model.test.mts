// The settings window's "Test" for a model (routes/settings.ts
// testModel): one short question to an openai-compatible provider, the
// answer or the reason it failed; other engines are not asked.
//
// Run: npm test src/server/routes/settings-test-model.test.mts
import '../../testing/isolated-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { testModel } = await import('./settings.ts');
const { ConfigSchema } = await import('../../config/types.ts');

let seen: { auth?: string; body?: Record<string, unknown> } = {};
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c)).on('end', () => {
    seen = { auth: req.headers.authorization, body: JSON.parse(raw) };
    if (req.url!.startsWith('/empty/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url!.startsWith('/broken/')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"model not loaded"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: ' OK ' } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const model = { id: 'm1', contextWindow: 8000 };
const thinker = { id: 't1', contextWindow: 8000, capabilities: ['text', 'reasoning'], reasoning: { default: 'off', levels: { off: 'none' } }, sampling: { temperature: 0.3 } };
const config = ConfigSchema.parse({
  providers: {
    good: { engine: 'openai-compatible', baseUrl: `${base}/v1/`, apiKey: 'k1', models: [model, thinker] },
    bad: { engine: 'openai-compatible', baseUrl: `${base}/broken/v1`, apiKey: 'k2', models: [model] },
    empty: { engine: 'openai-compatible', baseUrl: `${base}/empty/v1`, apiKey: 'k3', models: [model] },
    cli: { engine: 'claude-cli', models: [{ id: 'sonnet', contextWindow: 200000 }] },
  },
});

test('a model that answers: ok, the time and its words; the key goes along', async () => {
  const r = await testModel(config, 'good', 'm1');
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'OK');
  assert.equal(seen.auth, 'Bearer k1');
  assert.equal(seen.body?.model, 'm1');
});

test('the model is asked with its own saved reasoning level and sampling', async () => {
  const r = await testModel(config, 'good', 't1');
  assert.equal(r.ok, true);
  assert.equal(seen.body?.reasoning_effort, 'none');
  assert.equal(seen.body?.temperature, 0.3);
});

test('a provider that fails says how; unknown names and other engines are not asked', async () => {
  const bad = await testModel(config, 'bad', 'm1');
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /HTTP 500: .*model not loaded/);
  assert.match((await testModel(config, 'empty', 'm1')).error!, /no completion/);
  assert.match((await testModel(config, 'nope', 'm1')).error!, /apply first/);
  assert.match((await testModel(config, 'good', 'other')).error!, /apply first/);
  assert.match((await testModel(config, 'cli', 'sonnet')).note!, /claude-cli models are not asked directly/);
});
