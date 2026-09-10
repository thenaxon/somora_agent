// The vision worker is a SUBSTITUTE for models that cannot see, and it
// has to stay inside a budget.
//
// 2026-09-10: 142 dispatches in the live logs, 67 with a failing worker,
// every one of them from an agent whose own model has `image`. One tool
// call took 176 s because four workers each burned their own timeout.
// So: hide the tool from models that can see, cap the output, and bound
// the whole chain, not just one attempt.
//
// Run: npm test src/tools/file/analyze.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFile, describeMedia } from './analyze.ts';
import { loadAttachment } from '../../multimodal/load.ts';
import type { Config, ResolvedModel } from '../../config/types.ts';
import type { ToolContext } from '../types.ts';

// A 1x1 PNG is a real image as far as the loader is concerned.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const dir = mkdtempSync(join(tmpdir(), 'somora-vision-'));
const imagePath = join(dir, 'shot.png');
writeFileSync(imagePath, PNG);

/** Worker behaviour per model id, so one server serves the whole chain. */
type Behaviour = { kind: 'ok'; text: string } | { kind: 'slow'; ms: number } | { kind: 'empty'; stop: string };
const behaviour = new Map<string, Behaviour>();
const requests: Array<{ model: string; maxTokens: unknown }> = [];

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; max_tokens?: number };
        requests.push({ model: parsed.model, maxTokens: parsed.max_tokens });
        const b = behaviour.get(parsed.model) ?? { kind: 'ok', text: 'a picture' };
        const send = (payload: unknown) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (b.kind === 'slow') {
          setTimeout(() => send({ choices: [{ message: { content: 'too late' }, finish_reason: 'stop' }] }), b.ms);
          return;
        }
        if (b.kind === 'empty') {
          send({ choices: [{ message: { content: '' }, finish_reason: b.stop }] });
          return;
        }
        send({ choices: [{ message: { content: b.text }, finish_reason: 'stop' }] });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function config(port: number, over: Partial<Config['vision']> = {}): Config {
  const model = (id: string) => ({
    id,
    alias: id,
    capabilities: ['text', 'image'] as string[],
    contextWindow: 8000,
  });
  return {
    providers: {
      local: {
        engine: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        models: [model('fast'), model('slow'), model('thinker')],
      },
    },
    vision: {
      worker: ['local/fast'],
      timeoutMs: 60_000,
      totalBudgetMs: 90_000,
      maxOutputTokens: 1_500,
      healthCacheMs: 60_000,
      timeoutCooldownMs: 10_000,
      ...over,
    },
    attachments: { maxImageBytes: 20_000_000, maxPdfBytes: 32_000_000, maxTextBytes: 1_000_000 },
  } as unknown as Config;
}

const visionModel = (caps: string[]): ResolvedModel =>
  ({ providerName: 'p', modelId: 'm', model: { capabilities: caps } }) as unknown as ResolvedModel;

test('the tool is only offered to models that cannot see', async () => {
  const { server, port } = await startServer();
  try {
    const cfg = config(port);
    const ctx = (over: Partial<ToolContext>) => ({ agent: 'a', config: cfg, ...over }) as ToolContext;
    assert.equal(await analyzeFile.available!(ctx({ activeModel: visionModel(['text']) })), true, 'text-only model gets the substitute');
    assert.equal(await analyzeFile.available!(ctx({ activeModel: visionModel(['text', 'image']) })), false, 'a model that can see never sees the tool');
    assert.equal(await analyzeFile.available!(ctx({})), true, 'unknown active model (debug invoke) keeps it');
    const noWorker = { ...cfg, vision: { ...cfg.vision, worker: undefined } } as unknown as Config;
    assert.equal(await analyzeFile.available!(ctx({ config: noWorker, activeModel: visionModel(['text']) })), false, 'no worker configured, no tool');
  } finally {
    server.close();
  }
});

test('one answer costs one capped request; a whole chain stays inside its budget', async (t) => {
  const { server, port } = await startServer();
  const att = await loadAttachment(imagePath, { maxImageBytes: 20_000_000, maxPdfBytes: 1, maxTextBytes: 1 });
  t.after(() => server.close());

  await t.test('the worker answer comes back with the vision output cap, not the chat cap', async () => {
    requests.length = 0;
    behaviour.set('fast', { kind: 'ok', text: 'a cat on a keyboard' });
    const r = await describeMedia({ att, config: config(port, { maxOutputTokens: 300 }), agent: 'a', caller: 'analyze_file' });
    assert.equal(r.analysis, 'a cat on a keyboard');
    assert.equal(r.worker, 'local/fast');
    assert.deepEqual(requests.map((x) => x.maxTokens), [300], 'vision.maxOutputTokens is what the worker gets');
  });

  await t.test('a slow worker is passed over and the next one answers', async () => {
    requests.length = 0;
    behaviour.set('slow', { kind: 'slow', ms: 3_000 });
    behaviour.set('fast', { kind: 'ok', text: 'described' });
    const started = Date.now();
    const r = await describeMedia({
      att,
      config: config(port, { worker: ['local/slow', 'local/fast'], timeoutMs: 500 }),
      agent: 'a',
      caller: 'analyze_file',
    });
    assert.equal(r.worker, 'local/fast');
    assert.match(r.fellBackFrom?.join(' ') ?? '', /no answer within/);
    assert.ok(Date.now() - started < 2_500, 'it did not wait out the slow worker');
  });

  await t.test('the chain budget stops the walk instead of paying every timeout', async () => {
    behaviour.set('slow', { kind: 'slow', ms: 5_000 });
    const started = Date.now();
    await assert.rejects(
      describeMedia({
        att,
        // Four slow workers, one attempt of 1s each, but only 2.5s in total.
        config: config(port, {
          worker: ['local/slow', 'local/slow', 'local/slow', 'local/slow'],
          timeoutMs: 1_000,
          totalBudgetMs: 2_500,
          timeoutCooldownMs: 0,
        }),
        agent: 'a',
        caller: 'analyze_file',
      }),
      /chain budget spent|no vision worker could handle/,
    );
    const spent = Date.now() - started;
    assert.ok(spent < 4_000, `chain gave up after ${spent} ms instead of walking all four`);
  });

  await t.test('a worker that thinks past its output cap says so instead of "empty response"', async () => {
    behaviour.set('thinker', { kind: 'empty', stop: 'length' });
    await assert.rejects(
      describeMedia({
        att,
        config: config(port, { worker: ['local/thinker'], timeoutCooldownMs: 0, healthCacheMs: 0 }),
        agent: 'a',
        caller: 'analyze_file',
      }),
      /finish_reason=length|raise vision.maxOutputTokens/,
    );
  });
});
