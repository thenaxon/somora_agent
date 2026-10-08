// decision client against a fake System One server: translation, limits, errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { effectiveInputLimit, estimateInputTokens, evaluateDecision, fromWireAnswers, serverInputLimit } from './client.ts';
import type { DecisionModel } from '../config/types.ts';

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;
let handler: Handler = () => {};
let modelsLimit: number | null = 65536;
let lastBody: Record<string, unknown> = {};
let lastAuth: string | undefined;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d)).on('end', () => {
    lastAuth = req.headers.authorization;
    if (req.url === '/clef/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'clef', ...(modelsLimit ? { max_input_tokens: modelsLimit } : {}) }] }));
      return;
    }
    lastBody = raw ? JSON.parse(raw) : {};
    handler(req, lastBody, res);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const port = (server.address() as AddressInfo).port;

let n = 0;
/** A fresh entry per test: the server limit is cached per baseUrl+model. */
function model(over: Partial<DecisionModel> = {}): DecisionModel {
  return { name: 'clef', baseUrl: `http://127.0.0.1:${port}/clef`, model: `clef${n++ === 0 ? '' : n}`, capabilities: ['text', 'image'], timeoutMs: 5000, apiKey: 'k', ...over };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const okAnswers = {
  model: 'clef',
  answers: {
    down: { type: 'noul', noul: 0.82 },
    team: { type: 'choice', choice: 'technical', confidence: 0.77, probabilities: { billing: 0.23, technical: 0.77 } },
    urgency: { type: 'score', score: 1.87, confidence: 0.89, legend: { 0: 'later', 1: 'week', 2: 'today' }, probabilities: { 0: 0.03, 1: 0.08, 2: 0.89 } },
  },
  usage: { input_tokens: 306, output_tokens: 0 },
};
const questions = {
  down: { type: 'boolean' as const, instructions: 'Is a service down?' },
  team: { type: 'choice' as const, criteria: { billing: 'Payments', technical: 'Bugs' } },
  urgency: { type: 'score' as const, criteria: ['later', 'week', 'today'] },
};

test('boolean goes out as noul and comes back as probabilityTrue; score gets its max', async () => {
  handler = (_q, _b, res) => json(res, 200, okAnswers);
  const m = model();
  const o = await evaluateDecision(m, { state: 'Checkout fails.', questions });
  assert.equal(o.status, 'ok');
  assert.equal((lastBody.questions as Record<string, { type: string }>).down!.type, 'noul');
  assert.equal(lastBody.model, m.model);
  assert.equal(lastAuth, 'Bearer k');
  if (o.status !== 'ok') return;
  assert.deepEqual(o.answers.down, { type: 'boolean', probabilityTrue: 0.82 });
  assert.equal(o.answers.team!.type === 'choice' && o.answers.team!.choice, 'technical');
  assert.deepEqual(o.answers.urgency, { type: 'score', score: 1.87, max: 2, confidence: 0.89, probabilities: [0.03, 0.08, 0.89], legend: ['later', 'week', 'today'] });
  assert.equal(o.inputLimit, 65536);
});

test('no key configured: no Authorization header', async () => {
  handler = (_q, _b, res) => json(res, 200, okAnswers);
  await evaluateDecision(model({ apiKey: undefined }), { state: 's', questions });
  assert.equal(lastAuth, undefined);
});

test('answers that do not match the questions are rejected, not passed on', () => {
  assert.equal(fromWireAnswers({ down: { type: 'choice' } }, { down: { type: 'boolean' } }), null);
  assert.equal(fromWireAnswers({ t: { type: 'choice', choice: 'x', confidence: 1, probabilities: { a: 1, b: 0 } } }, { t: { type: 'choice', criteria: { a: 1, b: 2 } } }), null);
  assert.equal(fromWireAnswers({ s: { type: 'score', score: 5, confidence: 1, probabilities: { 0: 0.5, 1: 0.5 } } }, { s: { type: 'score', criteria: ['a', 'b'] } }), null);
  assert.equal(fromWireAnswers({}, { x: { type: 'boolean' } }), null);
});

test('HTTP errors map to reasons with guidance; the server message is kept', async () => {
  const cases: [number, unknown, string][] = [
    [401, { error: { message: 'bad key' } }, 'authentication'],
    [429, {}, 'rate-limited'],
    [413, { error: { type: 'input_too_long', message: 'input is 70539 tokens, limit is 65536; nothing was truncated' } }, 'too-long'],
    [422, { error: { type: 'invalid_request', message: 'down: type must be noul, choice, or score' } }, 'unsupported-input'],
    [503, { error: { message: 'model not loaded' } }, 'not-ready'],
    [529, {}, 'not-ready'],
    [500, {}, 'transport'],
  ];
  for (const [status, body, reason] of cases) {
    handler = (_q, _b, res) => json(res, status, body);
    const o = await evaluateDecision(model(), { state: 's', questions });
    assert.equal(o.status, 'unavailable', `${status}`);
    if (o.status !== 'unavailable') continue;
    assert.equal(o.reason, reason, `${status}`);
    assert.ok(o.guidance.length > 20);
    const msg = (body as { error?: { message?: string } }).error?.message;
    // Kept where it helps the agent (413/422/503); not for 401, whose text
    // may echo credentials.
    if (msg && status !== 401) assert.equal(o.detail, msg, `${status} keeps the server's message`);
    if (status === 401) assert.equal(o.detail, undefined);
  }
  handler = (_q, _b, res) => { res.writeHead(200); res.end('not json'); };
  assert.equal((await evaluateDecision(model(), { state: 's', questions }) as { reason: string }).reason, 'invalid-response');
});

test('server gone → transport; too slow → deadline', async () => {
  const gone = await evaluateDecision(model({ baseUrl: 'http://127.0.0.1:1/x' }), { state: 's', questions });
  assert.equal((gone as { reason: string }).reason, 'transport');
  handler = (_q, _b, res) => setTimeout(() => json(res, 200, okAnswers), 3000);
  const slow = await evaluateDecision(model({ timeoutMs: 5000 - 4800 + 300 }), { state: 's', questions });
  assert.equal((slow as { reason: string }).reason, 'deadline');
});

test('limits: ours wins when lower, the server\'s when ours is higher or missing', async () => {
  assert.equal(effectiveInputLimit(32768, 65536), 32768);
  assert.equal(effectiveInputLimit(100000, 65536), 65536);
  assert.equal(effectiveInputLimit(undefined, 65536), 65536);
  assert.equal(effectiveInputLimit(32768, null), 32768);
  assert.equal(effectiveInputLimit(undefined, null), null);
  modelsLimit = 16384;
  assert.equal(await serverInputLimit(model()), 16384);
  modelsLimit = 65536;
});

test('a clearly too long input is refused before sending', async () => {
  let sent = false;
  handler = (_q, _b, res) => { sent = true; json(res, 200, okAnswers); };
  const o = await evaluateDecision(model({ maxInputTokens: 1000 }), { state: 'wort '.repeat(2000), questions });
  assert.equal((o as { reason: string }).reason, 'too-long');
  assert.equal(sent, false, 'nothing went out');
  assert.match((o as { detail: string }).detail, /limit is 1000/);
});

test('images count toward the estimate (~3 000 tokens for 2048×1536)', () => {
  const t = estimateInputTokens({ state: '', questions: {}, images: [{ base64: '', width: 2048, height: 1536 }] });
  assert.ok(t > 3000 && t < 3300, String(t));
});

test('silent truncation at the server limit is caught; over OUR limit after the fact too', async () => {
  handler = (_q, _b, res) => json(res, 200, { ...okAnswers, usage: { input_tokens: 65536, output_tokens: 0 } });
  const cut = await evaluateDecision(model(), { state: 's', questions });
  assert.equal((cut as { reason: string }).reason, 'truncated');
  handler = (_q, _b, res) => json(res, 200, { ...okAnswers, usage: { input_tokens: 40000, output_tokens: 0 } });
  const over = await evaluateDecision(model({ maxInputTokens: 32768 }), { state: 's', questions });
  assert.equal((over as { reason: string }).reason, 'too-long');
  assert.match((over as { detail: string }).detail, /40000 tokens, the configured limit is 32768/);
});

test('images to a text-only model: refused without a request', async () => {
  let sent = false;
  handler = (_q, _b, res) => { sent = true; json(res, 200, okAnswers); };
  const o = await evaluateDecision(model({ capabilities: ['text'] }), { state: 's', questions, images: [{ base64: 'x', width: 1, height: 1 }] });
  assert.equal((o as { reason: string }).reason, 'images-unsupported');
  assert.equal(sent, false);
});
