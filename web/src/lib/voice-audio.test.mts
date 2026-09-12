// The format conversions the voice window depends on (2026-09-11), and
// how much speech is still waiting to be heard (2026-09-12).
//
// Run: cd web && npx tsx src/lib/voice-audio.test.mts
//
// Audio bugs are invisible until someone hears them, and by then the
// call is over. These are the two lossy steps between a microphone and
// a provider, so they get pinned: a round trip must come back as what
// went in, and clipping must clip rather than wrap around into noise.
import assert from 'node:assert/strict';

import { createVoicePlayer, floatToPcm16Base64, pcm16Base64ToFloat, VOICE_RATE_HZ } from './voice-audio';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

// btoa/atob exist in the browser; node 22 has them too.
{
  const input = new Float32Array([0, 0.5, -0.5, 0.25, -0.25]);
  const round = pcm16Base64ToFloat(floatToPcm16Base64(input));
  check('a round trip keeps the length', round.length === input.length, `${round.length}`);
  const maxErr = Math.max(...[...input].map((v, i) => Math.abs(v - (round[i] ?? 0))));
  check('and the samples, within 16-bit resolution', maxErr < 0.0001, String(maxErr));
}

{
  // A loud speaker produces values past 1.0. Without clamping these
  // wrap around in the Int16 conversion and turn into a crackle that
  // sounds like a broken connection.
  const hot = new Float32Array([1.8, -1.8]);
  const round = pcm16Base64ToFloat(floatToPcm16Base64(hot));
  check('clipping stays clipped, not wrapped', (round[0] ?? 0) > 0.9 && (round[1] ?? 0) < -0.9, JSON.stringify([...round]));
}

{
  const silence = new Float32Array(480);
  const b64 = floatToPcm16Base64(silence);
  check('silence is still a frame, not an empty string', b64.length > 0);
  check('and decodes back to silence', pcm16Base64ToFloat(b64).every((v) => v === 0));
}

{
  check('both sides agree on 24 kHz', VOICE_RATE_HZ === 24_000);
  const oneSecond = new Float32Array(VOICE_RATE_HZ);
  const bytes = atob(floatToPcm16Base64(oneSecond)).length;
  check('one second is 48000 bytes of PCM16', bytes === VOICE_RATE_HZ * 2, String(bytes));
}

// ── how much is still queued ────────────────────────────────────────
// A handover is announced by the server the moment the new session is
// live. The browser can still be seconds behind: chunks arrive faster
// than real time, so the previous agent's last sentence is sitting in
// the queue. The window asks the player how far behind it is before it
// changes name and colour — without that, lisa finishes her sentence
// under hans's name (Rene, 2026-09-12).
{
  let now = 0;
  const node = () => ({
    buffer: null as unknown,
    connect() {},
    start() {},
    stop() {},
    onended: null as null | (() => void),
  });
  const fakeCtx = {
    get currentTime() { return now; },
    destination: {},
    createAnalyser: () => ({
      fftSize: 512,
      connect() {},
      getFloatTimeDomainData(b: Float32Array) { b.fill(0); },
    }),
    createBuffer: (_ch: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: node,
    close() {},
  };
  const player = createVoicePlayer(fakeCtx as unknown as AudioContext);

  check('an idle player has nothing queued', player.pendingMs() === 0, String(player.pendingMs()));

  // One second of speech, handed over in one chunk.
  const second = floatToPcm16Base64(new Float32Array(VOICE_RATE_HZ));
  player.play(second);
  check('after a second of speech, a second is queued', Math.round(player.pendingMs()) === 1000, String(player.pendingMs()));

  now = 0.4;
  check('it counts down as it plays', Math.round(player.pendingMs()) === 600, String(player.pendingMs()));

  // Chunks queue behind each other rather than on top.
  player.play(second);
  check('a second chunk queues behind the first', Math.round(player.pendingMs()) === 1600, String(player.pendingMs()));

  now = 2.0;
  check('and it is empty once everything has been heard', player.pendingMs() === 0, String(player.pendingMs()));

  // Barge-in drops what was not heard, so nothing keeps the window
  // waiting for audio that will never play.
  player.play(second);
  player.stop();
  check('an interruption empties the queue at once', player.pendingMs() === 0, String(player.pendingMs()));
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
