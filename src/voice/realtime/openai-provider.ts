// The OpenAI adapter: somora's contract on one side, OpenAI's realtime
// event vocabulary on the other.
//
// Transport is the server-side WebSocket, deliberately:
//
//   - Tool calls arrive HERE, so somora executes them on exactly one
//     path. With WebRTC the control channel sits in the browser, and
//     OpenAI's sideband for attaching a server to a browser call
//     (`wss://…/v1/realtime?call_id=…`) answered `call_id_not_found`
//     for ephemeral-key calls through 2026-09-10, working only when the
//     SDP offer was posted with the real API key.
//   - OpenClaw does the same for its tool-backed calls (read from their
//     bundle 2026-09-11): a server WebSocket to
//     `wss://api.openai.com/v1/realtime?model=…`, tool answers as
//     `conversation.item.create` + `response.create`.
//
// The cost is one extra hop for the audio. On a tailnet, against a
// model that thinks for hundreds of milliseconds, that is the cheaper
// trade than an ambiguous tool path.

import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import type {
  RealtimeAudioChunk,
  RealtimeCapabilities,
  RealtimeClientHandshake,
  RealtimeEvent,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionRequest,
} from './types.ts';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
/** OpenAI's realtime audio is PCM16; 24 kHz is what the session
 *  defaults to and what the browser side has to match. */
const AUDIO_RATE_HZ = 24_000;

export interface OpenAiRealtimeOptions {
  /** Read from a file, never from config.yaml — a realtime key buys
   *  billed minutes and config is read by more eyes than a 600 file. */
  apiKeyFile?: string;
  apiKey?: string;
  /** Injectable for tests: anything that behaves like a ws socket. */
  connect?: (url: string, headers: Record<string, string>) => WebSocketLike;
}

/** The slice of `ws` this adapter uses. */
export interface WebSocketLike {
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

function loadKey(opts: OpenAiRealtimeOptions): string {
  if (opts.apiKey) return opts.apiKey;
  if (opts.apiKeyFile) {
    const key = readFileSync(opts.apiKeyFile, 'utf8').trim();
    if (key.length === 0) throw new Error(`realtime key file ${opts.apiKeyFile} is empty`);
    return key;
  }
  throw new Error('no realtime key: set realtimeVoice.apiKeyFile');
}

class OpenAiRealtimeSession implements RealtimeSession {
  readonly id: string;
  private queue: RealtimeEvent[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  /** The model is mid-answer. Used to tell a barge-in apart from the
   *  normal start of a user turn. */
  private speaking = false;
  /**
   * A response is open on the provider's side.
   *
   * Asking for a second one while the first runs is refused:
   * "Conversation already has an active response in progress"
   * (seen live 2026-09-11, right after a tool answer landed while the
   * voice self was still saying "moment, ich schau nach"). The answer
   * item is accepted either way — only the request to SPEAK has to
   * wait, so it is deferred to the next `response.done`.
   */
  private responseActive = false;
  private speakWhenFree = false;

  /** Ask the model to speak, or remember to ask once it is free.
   *
   *  The flag is set the moment WE ask, not when the server confirms:
   *  `response.created` comes back over the network, and between our
   *  request and that echo a second request slips through. That gap is
   *  how the error came back on 2026-09-11 even with a guard in place —
   *  the filler for a lookup and the answer to it were sent
   *  milliseconds apart. */
  private requestResponse(payload?: Record<string, unknown>): void {
    if (this.responseActive) {
      this.speakWhenFree = true;
      return;
    }
    this.responseActive = true;
    this.send({ type: 'response.create', ...(payload ? { response: payload } : {}) });
  }

  constructor(
    private readonly ws: WebSocketLike,
    private readonly req: RealtimeSessionRequest,
    id: string,
  ) {
    this.id = id;
    this.ws.on('message', (data: unknown) => this.onMessage(String(data)));
    this.ws.on('error', (err: Error) => this.push({ kind: 'error', ts: Date.now(), message: err.message, fatal: true }));
    this.ws.on('close', () => {
      this.push({ kind: 'closed', ts: Date.now(), reason: 'provider closed the connection' });
      this.finish();
    });
  }

  /** Configure the session the moment it opens: instructions, voice,
   *  the one tool, and transcription of the USER's audio — without
   *  that last one somora never learns what was actually said and the
   *  session history stays empty. */
  configure(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.req.model,
        instructions: this.req.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO_RATE_HZ },
            transcription: { model: 'whisper-1', language: this.req.language },
            turn_detection: {
              type: 'server_vad',
              // Tuned to be interruptible: the defaults wait for a
              // confident, sustained speaker, which makes talking over
              // the model hard (Rene, 2026-09-12).
              threshold: this.req.turnDetection?.threshold ?? 0.4,
              prefix_padding_ms: this.req.turnDetection?.prefixPaddingMs ?? 200,
              silence_duration_ms: this.req.turnDetection?.silenceDurationMs ?? 420,
              interrupt_response: true,
            },
          },
          output: { voice: this.req.voice },
        },
        tools: this.req.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: 'auto',
      },
    });
  }

  private send(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(obj));
  }

  private push(ev: RealtimeEvent): void {
    if (this.done) return;
    this.queue.push(ev);
    this.waiter?.();
    this.waiter = undefined;
  }

  private finish(): void {
    this.done = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    const ts = Date.now();
    switch (type) {
      case 'session.created':
      case 'session.updated':
        this.push({ kind: 'ready', ts });
        break;
      case 'input_audio_buffer.speech_started':
        this.push({ kind: 'user_speech', ts, phase: 'start' });
        // Talking over the model IS the interruption signal; there is
        // no separate event for it on this transport.
        if (this.speaking) {
          this.speaking = false;
          // Stop the answer at the source as well: dropping the
          // playback alone leaves the model talking into a void and
          // counting it as said.
          if (this.responseActive) this.send({ type: 'response.cancel' });
          this.push({ kind: 'interrupted', ts });
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        this.push({ kind: 'user_speech', ts, phase: 'end' });
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof msg.transcript === 'string' ? msg.transcript : '';
        if (text) this.push({ kind: 'user_transcript', ts, text, final: true });
        break;
      }
      case 'response.output_audio_transcript.delta': {
        const text = typeof msg.delta === 'string' ? msg.delta : '';
        if (text) this.push({ kind: 'model_transcript', ts, text, final: false });
        break;
      }
      case 'response.output_audio_transcript.done': {
        const text = typeof msg.transcript === 'string' ? msg.transcript : '';
        if (text) this.push({ kind: 'model_transcript', ts, text, final: true });
        break;
      }
      case 'response.output_audio.delta': {
        const b64 = typeof msg.delta === 'string' ? msg.delta : '';
        if (b64) {
          if (!this.speaking) {
            this.speaking = true;
            this.push({ kind: 'model_speech', ts, phase: 'start' });
          }
          this.push({ kind: 'audio', ts, base64: b64, rateHz: AUDIO_RATE_HZ });
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const callId = typeof msg.call_id === 'string' ? msg.call_id : '';
        const name = typeof msg.name === 'string' ? msg.name : '';
        const args = typeof msg.arguments === 'string' ? msg.arguments : '';
        if (callId && name) this.push({ kind: 'tool_call', ts, callId, name, args });
        break;
      }
      case 'response.created':
        this.responseActive = true;
        break;
      case 'response.done': {
        this.responseActive = false;
        if (this.speakWhenFree) {
          this.speakWhenFree = false;
          this.requestResponse();
        }
        if (this.speaking) {
          this.speaking = false;
          this.push({ kind: 'model_speech', ts, phase: 'end' });
        }
        const response = msg.response as { usage?: Record<string, unknown> } | undefined;
        const usage = response?.usage;
        if (usage) {
          this.push({
            kind: 'usage',
            ts,
            ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
          });
        }
        break;
      }
      case 'error': {
        const err = msg.error as { message?: unknown; type?: unknown } | undefined;
        const message = typeof err?.message === 'string' ? err.message : JSON.stringify(msg).slice(0, 300);
        // The server knows better than our bookkeeping: if it says a
        // response is running, one is. Remember to ask again when that
        // response reports done, so the answer is not lost.
        // Cancelling a response that just finished is the normal shape
        // of an interruption, not a fault: the user talks over the last
        // syllable and the cancel arrives a moment late. It was shown
        // in red to the human (Rene, 2026-09-12) — it belongs in the
        // log, nowhere else.
        if (/no active response/i.test(message)) {
          this.responseActive = false;
          break;
        }
        if (/active response in progress/i.test(message)) {
          this.responseActive = true;
          this.speakWhenFree = true;
          this.push({ kind: 'error', ts, message, fatal: false });
          break;
        }
        // A session-level error kills the call; an item-level one (a
        // rejected tool argument, say) must not — the conversation is
        // still alive and the model can be told.
        const fatal = typeof err?.type === 'string' && /session|invalid_request_error/i.test(err.type) === false;
        this.push({ kind: 'error', ts, message, fatal });
        break;
      }
      default:
        break;
    }
  }

  async *events(): AsyncGenerator<RealtimeEvent> {
    while (!this.done || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  /**
   * Microphone audio, as it arrives.
   *
   * The client must keep sending while nobody talks. Server-side turn
   * detection closes a turn on SILENCE, not on the absence of packets:
   * measured live 2026-09-11, a client that stopped sending at the end
   * of the sentence got `speech_started` and then nothing at all — no
   * transcript, no answer, a call that simply hung. A real microphone
   * streams silence; anything feeding this from a file has to do the
   * same.
   */
  async sendAudio(chunk: RealtimeAudioChunk): Promise<void> {
    this.send({ type: 'input_audio_buffer.append', audio: chunk.base64 });
  }

  async sendToolResult(callId: string, result: string): Promise<void> {
    // Two events, in this order: the answer becomes a conversation
    // item, then the model is asked to speak again. Without the second
    // one the call goes silent after a tool call — the model is waiting
    // for permission it never gets. But asking while it is still
    // talking is an error, so that half waits for the current response.
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: result },
    });
    this.requestResponse();
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.send({ type: 'session.update', session: { instructions } });
  }

  /** One spoken line under a one-off instruction, without touching the
   *  session's own. Skipped while the model is already talking — the
   *  filler exists to fill a silence, not to talk over an answer. */
  async speak(instructions: string): Promise<void> {
    // A filler only makes sense in a silence. If the model is talking,
    // dropping it is right — unlike a tool answer, which must be spoken
    // eventually and is therefore deferred rather than dropped.
    if (this.responseActive) return;
    this.requestResponse({ instructions });
  }

  async interrupt(): Promise<void> {
    this.send({ type: 'response.cancel' });
  }

  async close(reason: string): Promise<void> {
    this.push({ kind: 'closed', ts: Date.now(), reason });
    this.ws.close();
    this.finish();
  }
}

export class OpenAiRealtimeProvider implements RealtimeProvider {
  readonly name = 'openai';

  constructor(private readonly opts: OpenAiRealtimeOptions) {}

  capabilities(): RealtimeCapabilities {
    return {
      transport: 'websocket',
      serverVad: true,
      bargeIn: true,
      truncation: true,
      tools: true,
      liveInstructionUpdate: true,
      // Measured 2026-09-11: every session field may be updated at any
      // time except model and voice, voice only until the first audio.
      voiceFixedAfterFirstAudio: true,
      usage: true,
    };
  }

  async open(req: RealtimeSessionRequest): Promise<RealtimeSession> {
    const key = loadKey(this.opts);
    const url = `${REALTIME_URL}?model=${encodeURIComponent(req.model)}`;
    const headers = { Authorization: `Bearer ${key}` };
    const ws: WebSocketLike = this.opts.connect
      ? this.opts.connect(url, headers)
      : (new WebSocket(url, { headers }) as unknown as WebSocketLike);
    const session = new OpenAiRealtimeSession(ws, req, `oai-${Date.now()}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('realtime connect timed out after 20s')), 20_000);
      ws.on('open', () => {
        clearTimeout(timer);
        session.configure();
        resolve();
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return session;
  }

  async handshake(): Promise<RealtimeClientHandshake> {
    // On this transport the browser never talks to OpenAI: it streams
    // its microphone to somora and plays back what somora forwards.
    return { kind: 'sdp_broker', value: 'somora', url: '/voice/attach' };
  }
}
