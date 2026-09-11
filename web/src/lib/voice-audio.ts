// Microphone in, model out — the plumbing the voice window needs.
//
// Two rules decided this file, both learned the hard way:
//
//  1. **Keep sending, always.** The provider's turn detection closes a
//     turn on SILENCE, not on the absence of packets. Measured live
//     2026-09-11: a client that stopped sending when the speaker
//     stopped got "speech started" and then nothing — no transcript, no
//     answer, a call that simply hung. So the capture pump runs
//     continuously while the call is up, muted or not; muting sends
//     silence rather than nothing.
//  2. **The browser stays dumb.** It converts formats and moves bytes.
//     It does not know the provider, the tools, or the key.
//
// PCM16 at 24 kHz mono in both directions — what the session is
// configured for, so nobody resamples twice.

export const VOICE_RATE_HZ = 24_000;

/** Float samples (-1..1) → base64 PCM16, the wire format. */
export function floatToPcm16Base64(input: Float32Array): string {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

/** base64 PCM16 → Float samples, for playback. */
export function pcm16Base64ToFloat(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x8000;
  return out;
}

export interface MicCapture {
  /** Live level 0..1, for the animation. */
  level(): number;
  setMuted(muted: boolean): void;
  stop(): void;
}

/**
 * Start the microphone and call `onChunk` with base64 PCM16 forever —
 * including silence. `echoCancellation` matters on a speaker: without
 * it the model hears itself and interrupts itself.
 */
export async function startMicCapture(
  onChunk: (base64: string) => void,
  ctxIn?: AudioContext,
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = ctxIn ?? new AudioContext({ sampleRate: VOICE_RATE_HZ });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const buf = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  // ScriptProcessor is deprecated but universally available and exact
  // about frame sizes; an AudioWorklet would need a second file served
  // from the same origin for no functional gain here.
  const node = ctx.createScriptProcessor(2048, 1, 1);
  let muted = false;
  node.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    onChunk(floatToPcm16Base64(muted ? new Float32Array(input.length) : input));
  };
  source.connect(node);
  // A ScriptProcessor only fires when connected to a destination; a
  // zero gain keeps the user from hearing their own microphone.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);

  return {
    level: () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      return peak;
    },
    setMuted: (m: boolean) => { muted = m; },
    stop: () => {
      node.onaudioprocess = null;
      node.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      if (!ctxIn) void ctx.close();
    },
  };
}

export interface VoicePlayer {
  play(base64: string): void;
  /** Live level 0..1 of what is currently being spoken. */
  level(): number;
  /** Barge-in: drop everything not yet played. */
  stop(): void;
  close(): void;
}

/**
 * Queue-based playback.
 *
 * Chunks arrive faster than real time, so each one is scheduled after
 * the previous one ends rather than played on arrival — otherwise the
 * answer comes out as overlapping fragments. `stop()` drops the queue,
 * which is what an interruption has to do: the user talked over the
 * model, so what was not heard must not be played later.
 */
export function createVoicePlayer(ctxIn?: AudioContext): VoicePlayer {
  const ctx = ctxIn ?? new AudioContext({ sampleRate: VOICE_RATE_HZ });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  let cursor = 0;
  let sources: AudioBufferSourceNode[] = [];

  return {
    play: (base64: string) => {
      const samples = pcm16Base64ToFloat(base64);
      if (samples.length === 0) return;
      const audio = ctx.createBuffer(1, samples.length, VOICE_RATE_HZ);
      // copyToChannel wants a Float32Array over a plain ArrayBuffer;
      // the decoded view sits on the Int16 buffer.
      audio.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(analyser);
      const startAt = Math.max(ctx.currentTime, cursor);
      src.start(startAt);
      cursor = startAt + audio.duration;
      sources.push(src);
      src.onended = () => { sources = sources.filter((s) => s !== src); };
    },
    level: () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      return peak;
    },
    stop: () => {
      for (const src of sources) {
        try { src.stop(); } catch { /* already ended */ }
      }
      sources = [];
      cursor = 0;
    },
    close: () => {
      for (const src of sources) {
        try { src.stop(); } catch { /* already ended */ }
      }
      sources = [];
      if (!ctxIn) void ctx.close();
    },
  };
}
