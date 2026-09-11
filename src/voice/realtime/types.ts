// The contract somora speaks to a realtime voice provider.
//
// Three providers are in view and none of them share a protocol:
// OpenAI's realtime API, Google's `BidiGenerateContent`, and later our
// own local service. Verified 2026-09-11: Google's wire format is
// explicitly not the OpenAI one (different message names, 16 kHz in /
// 24 kHz out, its own interruption signal), and OpenRouter cannot carry
// either — its infrastructure is request/response, so a standing
// connection never gets through. So somora defines its own vocabulary
// here and each provider gets a thin adapter.
//
// The one rule that keeps this honest: an adapter DECLARES what it can
// do. A contract that pretends every provider can truncate a half-heard
// answer produces a silent no-op somewhere (the Hugging Face
// speech-to-speech server does exactly that today), and a feature that
// silently does nothing is worse than one that says it is missing.

/** What a provider can actually do. No optimistic defaults. */
export interface RealtimeCapabilities {
  /** How the browser's audio reaches the provider. */
  transport: 'webrtc' | 'websocket';
  /** The provider detects end-of-speech itself (server-side VAD). */
  serverVad: boolean;
  /** The user can talk over the model and the model stops. */
  bargeIn: boolean;
  /** A half-played answer can be cut back to what was really heard —
   *  without it the model believes it said things the user never got. */
  truncation: boolean;
  /** Function calling, i.e. the consult tool. Without it there is no
   *  point: the voice self could only talk, never ask the agent. */
  tools: boolean;
  /** The instructions (the voice persona) can change mid-call.
   *  OpenAI: yes. The VOICE cannot — see `voiceFixedAfterFirstAudio`. */
  liveInstructionUpdate: boolean;
  /** Measured on OpenAI 2026-09-11: every session field may be updated
   *  at any time EXCEPT model and voice, and voice only until the model
   *  has produced audio once. That is why switching agents mid-call is
   *  a fresh connection rather than a settings change. */
  voiceFixedAfterFirstAudio: boolean;
  /** The provider reports what a call cost. */
  usage: boolean;
}

/** Everything a call needs to open a provider session. */
export interface RealtimeSessionRequest {
  /** Provider model id, from config — never guessed. */
  model: string;
  /** Provider voice id, already mapped from the logical name. */
  voice: string;
  /** The voice self: who it is, how it speaks, and the hard rules. */
  instructions: string;
  /** Spoken language, BCP-47-ish ('de'), for transcription hints. */
  language: string;
  /** The tools the voice self may call. Always small — in v1 exactly
   *  one. These exist ONLY inside the provider session: they are not in
   *  somora's ToolRegistry, no agent can see or call them. */
  tools: RealtimeToolSpec[];
}

export interface RealtimeToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * What a provider session tells somora. Deliberately small: everything
 * a UI or the call state machine needs, nothing provider-shaped.
 */
export type RealtimeEvent =
  /** The connection is up and the model is listening. */
  | { kind: 'ready'; ts: number }
  /** The user started/stopped speaking (provider VAD). */
  | { kind: 'user_speech'; ts: number; phase: 'start' | 'end' }
  /** Transcript of the user's speech; `final` is what gets persisted. */
  | { kind: 'user_transcript'; ts: number; text: string; final: boolean }
  /** The model started/stopped speaking. */
  | { kind: 'model_speech'; ts: number; phase: 'start' | 'end' }
  /** What the model said, as text. `final` is the spoken record. */
  | { kind: 'model_transcript'; ts: number; text: string; final: boolean }
  /** The voice self wants somora to run one of its tools. */
  | { kind: 'tool_call'; ts: number; callId: string; name: string; args: string }
  /** The user talked over the model; playback should stop. */
  | { kind: 'interrupted'; ts: number }
  /** Audio the model is speaking, when it flows through somora. */
  | { kind: 'audio'; ts: number; base64: string; rateHz: number }
  /** Cost/usage, when the provider reports it. */
  | { kind: 'usage'; ts: number; inputTokens?: number; outputTokens?: number; seconds?: number }
  /** Terminal. `reason` is for the log and the UI, not for the model. */
  | { kind: 'closed'; ts: number; reason: string }
  | { kind: 'error'; ts: number; message: string; fatal: boolean };

/** A chunk of audio, base64 PCM16 at the rate the adapter declared. */
export interface RealtimeAudioChunk {
  base64: string;
  rateHz: number;
}

/**
 * A live provider session.
 *
 * Two transports, two audio paths, and the difference is not cosmetic:
 *
 *  - `websocket`: audio flows browser → somora → provider. One extra
 *    hop, but tool calls, session control and the key live in exactly
 *    one place. This is what OpenClaw uses for its tool-backed calls
 *    (read 2026-09-11: their bridge answers a tool with
 *    `conversation.item.create` + `response.create` over that socket).
 *  - `webrtc`: audio flows browser ↔ provider directly. Lower latency,
 *    but then the control channel is in the BROWSER — and somora's
 *    rule is that tools run server-side, on one path only. OpenAI's
 *    sideband (`wss://…/v1/realtime?call_id=…`) exists for exactly
 *    that, but as of 2026-09-09/10 it answers `call_id_not_found` for
 *    calls created with an ephemeral key; it works when the SDP offer
 *    was posted with the real API key. So WebRTC here means somora
 *    brokers the offer, never the browser.
 *
 * v1 ships the websocket path because it is provable end to end from a
 * script, without a browser and without ambiguity about who executes a
 * tool. The contract carries both so the faster one is an optimisation,
 * not a rewrite.
 */
export interface RealtimeSession {
  readonly id: string;
  /** Provider events, in order. Ends when the session closes. */
  events(): AsyncGenerator<RealtimeEvent>;
  /** Microphone audio, when the transport routes it through somora. */
  sendAudio?(chunk: RealtimeAudioChunk): Promise<void>;
  /** Answer a tool call the voice self made. */
  sendToolResult(callId: string, result: string): Promise<void>;
  /** Swap the voice persona mid-call (capability-gated). */
  updateInstructions(instructions: string): Promise<void>;
  /** Stop the model talking right now (barge-in, or the user hung up). */
  interrupt(): Promise<void>;
  close(reason: string): Promise<void>;
}

/** How the browser is told to reach the provider. The long-lived key
 *  NEVER leaves the server: an adapter hands out a short-lived token or
 *  brokers the handshake itself. */
export interface RealtimeClientHandshake {
  kind: 'ephemeral_token' | 'sdp_broker';
  /** For 'ephemeral_token': the short-lived credential and where to
   *  send the offer. For 'sdp_broker': the somora route to post to. */
  value: string;
  url?: string;
  expiresAt?: number;
}

export interface RealtimeProvider {
  readonly name: string;
  capabilities(): RealtimeCapabilities;
  /** Open a session. The adapter is responsible for auth; the caller
   *  passes only what the contract describes. */
  open(req: RealtimeSessionRequest): Promise<RealtimeSession>;
  /** What the browser needs to attach its microphone and speaker. */
  handshake(session: RealtimeSession): Promise<RealtimeClientHandshake>;
}
