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

  socket.server({ type: 'response.output_audio.delta', delta: 'AAAA' });
  socket.server({ type: 'input_audio_buffer.speech_started' });
  await tick();
  check('talking over the model does', events.some((e) => e.kind === 'interrupted'));
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
