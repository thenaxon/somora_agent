// The A2A client against a stand-in peer (docs/a2a.md): the card names
// the endpoint; a task is followed by polling (no stream) or over the
// stream; 0.3 peers get 0.3 method names, and files in the 0.3 shape
// when the client falls back; a question, a refusal and a failure come
// back as outcomes; a stop sends CancelTask and says whether the peer
// confirmed it; a task that runs too long is given up on; a status check
// that fails once is retried; a wrong token is an error.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { A2AError, clearCardCache, getCard, runTask } from './client.ts';
import { normalizeState, partsText, taskAnswer } from './protocol.ts';
import { filePart } from './files.ts';
import { startFakePeer, type FakePeer } from './__fixtures__/fake-peer.ts';

const peers: FakePeer[] = [];
after(async () => {
  for (const p of peers) await p.close();
});
async function peer(opts: Parameters<typeof startFakePeer>[0]): Promise<FakePeer> {
  const p = await startFakePeer(opts);
  peers.push(p);
  clearCardCache();
  return p;
}
const run = async (p: FakePeer, text: string, extra: Partial<Parameters<typeof runTask>[0]> = {}) => {
  const card = await getCard(p.url, { maxAgeMs: 60_000, ...(p.options.token ? { token: p.options.token } : {}) });
  return runTask({ card, text, maxMs: 10_000, pollMaxMs: 50, ...(p.options.token ? { token: p.options.token } : {}), ...extra });
};

test('states from both versions fold to one spelling', () => {
  assert.equal(normalizeState('TASK_STATE_INPUT_REQUIRED'), 'input_required');
  assert.equal(normalizeState('input-required'), 'input_required');
  assert.equal(normalizeState('cancelled'), 'canceled');
  assert.equal(normalizeState('TASK_STATE_COMPLETED'), 'completed');
  assert.equal(normalizeState(7), 'unknown');
  assert.equal(partsText([{ text: 'a' }, { kind: 'text', text: 'b' }, { data: { x: 1 } }, { url: 'https://h/f.png', filename: 'f.png' }]).includes('[file: f.png https://h/f.png]'), true);
  assert.equal(taskAnswer({ artifacts: [{ parts: [{ text: 'one' }] }, { parts: [{ text: 'two' }] }] }), 'one\n\ntwo');
  assert.equal(taskAnswer({ status: { message: { parts: [{ text: 'from status' }] } } }), 'from status');
});

test('a peer that does not stream: returns at once, then polled to the answer', async () => {
  const p = await peer({ workMs: 150 });
  const states: string[] = [];
  const out = await run(p, 'hello', { contextId: 'c1', onStatus: (s) => states.push(s) });
  assert.equal(out.state, 'completed');
  assert.equal(out.text, 'echo: hello');
  assert.equal(out.contextId, 'c1');
  const send = p.requests.find((r) => r.method === 'SendMessage')!;
  assert.equal(send.params.configuration.returnImmediately, true);
  assert.equal(send.params.message.role, 'ROLE_USER');
  assert.equal(send.params.message.contextId, 'c1');
  assert.ok(p.requests.some((r) => r.method === 'GetTask'), 'it polled');
  assert.ok(states.includes('working'));
});

test('a streaming peer: text arrives in pieces, the whole answer at the end', async () => {
  const p = await peer({ streaming: true, workMs: 60, pieces: 3, finish: () => ({ state: 'TASK_STATE_COMPLETED', answer: 'one two three' }) });
  const seen: string[] = [];
  const out = await run(p, 'go', { onText: (t) => seen.push(t) });
  assert.equal(out.state, 'completed');
  assert.equal(out.text, 'one two three');
  assert.ok(seen.length >= 2, `streamed ${seen.length} times`);
  assert.equal(seen.at(-1), 'one two three');
  assert.equal(p.requests[0]!.method, 'SendStreamingMessage');
});

test('a 0.3 peer gets 0.3 names and shapes, polled or streamed', async () => {
  const p = await peer({ version: '0.3', workMs: 50 });
  const out = await run(p, 'old');
  assert.equal(out.state, 'completed');
  assert.equal(out.text, 'echo: old');
  const send = p.requests.find((r) => r.method === 'message/send')!;
  assert.equal(send.params.message.kind, 'message');
  assert.equal(send.params.message.role, 'user');
  assert.ok(p.requests.some((r) => r.method === 'tasks/get'));
  const s = await peer({ version: '0.3', streaming: true, pieces: 2, finish: () => ({ state: 'TASK_STATE_COMPLETED', answer: 'streamed old' }) });
  const out2 = await run(s, 'x');
  assert.equal(out2.text, 'streamed old');
});

test('a card that says 1.0 but a peer that only knows 0.3 names: falls back once', async () => {
  const p = await peer({ version: '0.3' });
  // Pretend the card claimed 1.0.
  const card = await getCard(p.url, { maxAgeMs: 60_000 });
  const out = await runTask({ card: { ...card, version: '1.0' }, text: 'mixed', maxMs: 5_000, pollMaxMs: 50 });
  assert.equal(out.state, 'completed');
  assert.deepEqual(
    p.requests.map((r) => r.method),
    ['SendMessage', 'message/send'],
  );
});

test('the fall back to 0.3 sends the files in the 0.3 shape too', async () => {
  const p = await peer({ version: '0.3' });
  const card = await getCard(p.url, { maxAgeMs: 60_000 });
  const parts = [filePart('1.0', { raw: 'aGVsbG8=', mediaType: 'image/png', filename: 'a.png' }), filePart('1.0', { url: 'https://files.example/b.pdf', mediaType: 'application/pdf', filename: 'b.pdf' })];
  const out = await runTask({ card: { ...card, version: '1.0' }, text: 'with files', parts, maxMs: 5_000, pollMaxMs: 50 });
  assert.equal(out.state, 'completed');
  const sent = p.requests.find((r) => r.method === 'message/send')!.params.message.parts;
  assert.deepEqual(sent.slice(1), [
    { kind: 'file', file: { bytes: 'aGVsbG8=', mimeType: 'image/png', name: 'a.png' } },
    { kind: 'file', file: { uri: 'https://files.example/b.pdf', mimeType: 'application/pdf', name: 'b.pdf' } },
  ]);
});

test('a question, a refusal and a failure are outcomes, with their text', async () => {
  const p = await peer({
    finish: (text) =>
      text === 'ask'
        ? { state: 'TASK_STATE_INPUT_REQUIRED', said: 'Which city?' }
        : text === 'no'
          ? { state: 'TASK_STATE_REJECTED', said: 'not allowed' }
          : { state: 'TASK_STATE_FAILED', said: 'disk full' },
  });
  assert.deepEqual([(await run(p, 'ask')).state, (await run(p, 'ask')).text], ['input_required', 'Which city?']);
  const no = await run(p, 'no');
  assert.equal(no.state, 'rejected');
  assert.equal(no.text, 'not allowed');
  const bad = await run(p, 'x');
  assert.equal(bad.state, 'failed');
  assert.equal(bad.text, 'disk full');
});

test('the same context keeps the conversation: the peer sees the earlier task', async () => {
  const p = await peer({ finish: (_t, _c, history) => ({ state: 'TASK_STATE_COMPLETED', answer: `heard before: ${history.join(',') || 'nothing'}` }) });
  await run(p, 'first', { contextId: 'keep' });
  const second = await run(p, 'second', { contextId: 'keep' });
  assert.equal(second.text, 'heard before: first');
  const fresh = await run(p, 'third', { contextId: 'other' });
  assert.equal(fresh.text, 'heard before: nothing');
});

test('a stop sends CancelTask; the outcome says whether the peer confirmed', async () => {
  const p = await peer({ workMs: 5_000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const out = await run(p, 'long', { signal: ac.signal });
  assert.equal(out.state, 'canceled');
  assert.equal(out.cancelConfirmed, true);
  assert.equal(p.cancelled.length, 1);

  const q = await peer({ workMs: 5_000, cancel: 'unsupported' });
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 150);
  const out2 = await run(q, 'long', { signal: ac2.signal });
  assert.equal(out2.state, 'canceled');
  assert.equal(out2.cancelConfirmed, false, 'OpenClaw refuses CancelTask');
});

test('a stop during a stream cancels too', async () => {
  const p = await peer({ streaming: true, workMs: 5_000, pieces: 50, finish: () => ({ state: 'TASK_STATE_COMPLETED', answer: 'x'.repeat(500) }) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const out = await run(p, 'long', { signal: ac.signal });
  assert.equal(out.state, 'canceled');
  assert.equal(p.cancelled.length, 1);
});

test('a task that runs longer than allowed is given up on (and cancelled where possible)', async () => {
  const p = await peer({ workMs: 10_000 });
  const t = Date.now();
  const out = await run(p, 'slow', { maxMs: 300 });
  assert.equal(out.state, 'canceled');
  assert.match(out.text, /^gave up/);
  assert.ok(Date.now() - t < 3_000);
  assert.equal(p.cancelled.length, 1);
});

test('a status check that fails on the way is retried', async () => {
  const p = await peer({ workMs: 100, failGets: 2 });
  const out = await run(p, 'flaky');
  assert.equal(out.state, 'completed');
  assert.ok(p.requests.filter((r) => r.method === 'GetTask').length >= 3);
});

test('the token goes along; a wrong one is an auth error', async () => {
  const p = await peer({ token: 'right' });
  const out = await run(p, 'hi');
  assert.equal(out.state, 'completed');
  assert.equal(p.requests[0]!.auth, 'Bearer right');
  const card = await getCard(p.url, { maxAgeMs: 60_000 });
  await assert.rejects(runTask({ card, token: 'wrong', text: 'x', maxMs: 2_000, pollMaxMs: 50 }), (e: unknown) => e instanceof A2AError && e.kind === 'auth');
});

test('no card, no endpoint: clear errors', async () => {
  clearCardCache();
  await assert.rejects(getCard('http://127.0.0.1:9', { maxAgeMs: 1 }), (e: unknown) => e instanceof A2AError && e.kind === 'unreachable');
  const p = await peer({});
  await assert.rejects(getCard(`${p.url}/nothing`, { maxAgeMs: 1 }), (e: unknown) => e instanceof A2AError && /HTTP 404/.test((e as Error).message));
});
