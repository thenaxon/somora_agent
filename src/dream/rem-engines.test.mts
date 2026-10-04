// REM runs on every engine with a one-shot path — a subscription-only
// installation has no endpoint of its own, and the first version of REM
// refused its models on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-rem-engines-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.SOMORA_HOME = home;
const { extractFromSession } = await import('./rem-extract.ts');
const { hasOneShotPath } = await import('./deep-llm.ts');

const events = [
  { kind: 'user_message', ts: 1, text: 'the gate code is 4711' },
  { kind: 'assistant_message', ts: 2, text: 'noted' },
];
const worker = (engine: string) => ({
  providerName: 'p',
  modelId: 'm',
  provider: { engine, models: [] },
  model: { id: 'm', contextWindow: 200000, capabilities: ['text'] },
});
const run = (engine: string, signal?: AbortSignal) =>
  extractFromSession({ agent: 'ada', events, existingMemory: [], referencedVault: [], workerModel: worker(engine), chunkTimeoutMs: 5000, chunkTokens: 4000, ...(signal ? { signal } : {}) } as never);

test('one-shot path: the three engines, not grok-cli', () => {
  assert.equal(hasOneShotPath('openai-compatible'), true);
  assert.equal(hasOneShotPath('claude-cli'), true);
  assert.equal(hasOneShotPath('codex-cli'), true);
  assert.equal(hasOneShotPath('grok-cli'), false);
});

test('a worker on claude-cli or codex-cli is accepted (run cancelled before any call)', async () => {
  for (const engine of ['claude-cli', 'codex-cli']) {
    const ac = new AbortController();
    ac.abort();
    const r = await run(engine, ac.signal);
    assert.equal(r.completed, false, engine);
    assert.equal(r.totalChunks, 1, engine);
  }
});

test('an engine without a one-shot path is refused, and the message names what works', async () => {
  await assert.rejects(run('grok-cli'), /engine 'grok-cli', which cannot run REM — use a model on claude-cli, codex-cli or an openai-compatible provider/);
});
