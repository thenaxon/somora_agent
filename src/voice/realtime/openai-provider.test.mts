// The OpenAI adapter: their event vocabulary into ours (2026-09-11).
//
// Run: npx tsx src/voice/realtime/openai-provider.test.mts
//
// Every line here is a message shape taken from the live API or from
// OpenClaw's bundle, not from memory. What the test protects is the
// translation: a tool call must arrive as a tool call, a barge-in must
// be told apart from the start of a normal turn, and an item-level
// error must not kill a call that is still alive.
import assert from 'node:assert/strict';

import { OpenAiRealtimeProvider, type WebSocketLike } from './openai-provider.ts';
import type { RealtimeEvent } from './types.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Array<(arg: never) => void>>();
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (arg: never) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (a?: unknown) => void)(arg);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  /** A server message, as the API sends it. */
  server(obj: object): void { this.emit('message', JSON.stringify(obj)); }
}

async function openSession(): Promise<{ socket: FakeSocket; events: RealtimeEvent[]; session: Awaited<ReturnType<OpenAiRealtimeProvider['open']>> }> {
  const socket = new FakeSocket();
  const provider = new OpenAiRealtimeProvider({ apiKey: 'test-key', connect: () => socket });
  const opening = provider.open({
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    instructions: 'you are the voice of hans',
    language: 'de',
    tools: [{ name: 'somora_agent_consult', description: 'ask hans', parameters: { type: 'object', properties: {} } }],
  });
  socket.emit('open');
  const session = await opening;
  const events: RealtimeEvent[] = [];
  void (async () => { for await (const ev of session.events()) events.push(ev); })();
  return { socket, events, session };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── what somora tells the provider at the start ──────────────────────
{
  const { socket } = await openSession();
  const update = JSON.parse(socket.sent[0] ?? '{}') as {
    type?: string;
    session?: { instructions?: string; tools?: Array<{ name?: string }>; audio?: { input?: { transcription?: unknown; turn_detection?: { type?: string } }; output?: { voice?: string } } };
  };
  check('the session is configured on open', update.type === 'session.update', String(update.type));
  check('with the voice self', update.session?.instructions === 'you are the voice of hans');
  check('with the chosen voice', update.session?.audio?.output?.voice === 'marin');
  check('with the one tool', update.session?.tools?.length === 1 && update.session.tools[0]?.name === 'somora_agent_consult');
  check(
    'and with transcription of the USER — without it the session history stays empty',
    !!update.session?.audio?.input?.transcription,
  );
  check('server-side turn detection is on', update.session?.audio?.input?.turn_detection?.type === 'server_vad');
  // Talking over the model was hard with the provider defaults, which
  // wait for a confident sustained speaker (Rene, 2026-09-12).
  const vad = update.session?.audio?.input?.turn_detection as
    | { threshold?: number; prefix_padding_ms?: number; silence_duration_ms?: number; interrupt_response?: boolean }
    | undefined;
  check('it is tuned to be interruptible', (vad?.threshold ?? 1) < 0.5, String(vad?.threshold));
  check('and reacts without a long run-up', (vad?.prefix_padding_ms ?? 999) <= 200, String(vad?.prefix_padding_ms));
  check('and the provider cuts the answer on interruption', vad?.interrupt_response === true);
}

// ── their events into ours ───────────────────────────────────────────
{
  const { socket, events } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({ type: 'input_audio_buffer.speech_started' });
  socket.server({ type: 'input_audio_buffer.speech_stopped' });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Wie weit ist der Umbau?' });
  socket.server({ type: 'response.output_audio.delta', delta: 'AAAA' });
  socket.server({ type: 'response.output_audio_transcript.done', transcript: 'Fast fertig.' });
  socket.server({ type: 'response.done', response: { usage: { input_tokens: 120, output_tokens: 30 } } });
  await tick();

  const kinds = events.map((e) => e.kind);
  check('ready is reported', kinds.includes('ready'));
  check('user speech start and end', kinds.filter((k) => k === 'user_speech').length === 2);
  const transcript = events.find((e) => e.kind === 'user_transcript') as { text: string; final: boolean } | undefined;
  check('the user transcript arrives final', transcript?.final === true && transcript.text.includes('Umbau'));
  check('audio is passed through', events.some((e) => e.kind === 'audio'));
  check('the model speaking is reported once', kinds.filter((k) => k === 'model_speech').length === 2, kinds.join(','));
  check('what the model said arrives final', events.some((e) => e.kind === 'model_transcript' && e.final));
  check('usage is reported', events.some((e) => e.kind === 'usage'));
}

// ── barge-in is not the same as starting to talk ─────────────────────
{
  const { socket, events } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({ type: 'input_audio_buffer.speech_started' });
  await tick();
  check('speaking first does not count as an interruption', !events.some((e) => e.kind === 'interrupted'));

  socket.server({ type: 'response.created' });
  socket.server({ type: 'response.output_audio.delta', delta: 'AAAA' });
  socket.sent.length = 0;
  socket.server({ type: 'input_audio_buffer.speech_started' });
  await tick();
  check('talking over the model does', events.some((e) => e.kind === 'interrupted'));
  check(
    'and the answer is cancelled at the source, not just in the speaker',
    socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type).includes('response.cancel'),
    socket.sent.join(' '),
  );
}

// ── a tool call, and the two events that answer it ───────────────────
{
  const { socket, events, session } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'somora_agent_consult',
    arguments: '{"question":"Status?"}',
  });
  await tick();
  const call = events.find((e) => e.kind === 'tool_call') as { callId: string; name: string; args: string } | undefined;
  check('a tool call arrives as a tool call', call?.callId === 'call_1' && call.name === 'somora_agent_consult');

  socket.sent.length = 0;
  await session.sendToolResult('call_1', 'Umbau fertig.');
  const sent = socket.sent.map((s) => JSON.parse(s) as { type?: string; item?: { call_id?: string; output?: string } });
  check('the answer becomes a conversation item', sent[0]?.type === 'conversation.item.create' && sent[0].item?.call_id === 'call_1');
  check('carrying the agent\'s text', sent[0]?.item?.output === 'Umbau fertig.');
  check(
    'and the model is asked to speak again — without this the call goes silent',
    sent[1]?.type === 'response.create',
    JSON.stringify(sent.map((s) => s.type)),
  );
}

// ── asking to speak while it is already speaking ─────────────────────
{
  const { socket, session } = await openSession();
  socket.server({ type: 'session.created' });
  // The voice self is mid-acknowledgement when the agent's answer
  // lands. Live 2026-09-11 this produced "Conversation already has an
  // active response in progress" and the answer was never spoken.
  socket.server({ type: 'response.created' });
  socket.sent.length = 0;
  await session.sendToolResult('call_1', 'Umbau fertig.');
  let sent = socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type);
  check('the answer is still handed over at once', sent.includes('conversation.item.create'));
  check('but speaking is not requested yet', !sent.includes('response.create'), sent.join(','));

  socket.sent.length = 0;
  socket.server({ type: 'response.done', response: {} });
  await tick();
  sent = socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type);
  check('it is requested when the model falls silent', sent.includes('response.create'), sent.join(','));
}

// ── two requests to speak, milliseconds apart ───────────────────────
{
  const { socket, session } = await openSession();
  socket.server({ type: 'session.created' });
  socket.sent.length = 0;
  // The filler for a lookup and the answer to it, before the server has
  // echoed a single response.created. With the flag set only on the
  // echo, the second request went out and the API refused it — which is
  // how the error came back on 2026-09-11 with a guard already in
  // place.
  await session.speak?.('say you are checking');
  await session.sendToolResult('call_1', 'fertig');
  const types = socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type);
  check('only one response was requested', types.filter((t) => t === 'response.create').length === 1, types.join(','));
  check('and the answer was still handed over', types.includes('conversation.item.create'));

  socket.sent.length = 0;
  socket.server({ type: 'response.done', response: {} });
  await tick();
  const after = socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type);
  check('the deferred one goes out when it falls silent', after.includes('response.create'), after.join(','));
}

// ── the server's word beats our bookkeeping ─────────────────────────
{
  const { socket, session, events } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Conversation already has an active response in progress: resp_x.' },
  });
  await tick();
  check('the refusal is reported but not fatal', events.some((e) => e.kind === 'error' && !e.fatal));
  socket.sent.length = 0;
  await session.sendToolResult('call_2', 'antwort');
  check(
    'and nothing new is requested while it runs',
    !socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type).includes('response.create'),
  );
  socket.sent.length = 0;
  socket.server({ type: 'response.done', response: {} });
  await tick();
  check(
    'the answer is spoken once the model is free',
    socket.sent.map((x) => (JSON.parse(x) as { type?: string }).type).includes('response.create'),
  );
}

// ── a late cancel is not an error the human should see ──────────────
{
  const { socket, events } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Cancellation failed: no active response found' },
  });
  await tick();
  check(
    'the late cancel of an interruption stays out of the conversation',
    !events.some((e) => e.kind === 'error'),
    JSON.stringify(events.filter((e) => e.kind === 'error')),
  );
}

// ── an item-level error must not end a living call ───────────────────
{
  const { socket, events } = await openSession();
  socket.server({ type: 'session.created' });
  socket.server({ type: 'error', error: { type: 'invalid_request_error', message: 'unknown parameter' } });
  await tick();
  const err = events.find((e) => e.kind === 'error') as { message: string; fatal: boolean } | undefined;
  check('the error is surfaced', err?.message.includes('unknown parameter') === true);
  check('but not as fatal', err?.fatal === false);
}

// ── hanging up closes the socket and ends the stream ─────────────────
{
  const { socket, events, session } = await openSession();
  socket.server({ type: 'session.created' });
  await session.close('user hung up');
  await tick();
  check('the socket is closed', socket.closed);
  check('and the call reports why', events.some((e) => e.kind === 'closed' && e.reason === 'user hung up'));
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
