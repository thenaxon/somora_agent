// The format conversions the voice window depends on (2026-09-11).
//
// Run: cd web && npx tsx src/lib/voice-audio.test.mts
//
// Audio bugs are invisible until someone hears them, and by then the
// call is over. These are the two lossy steps between a microphone and
// a provider, so they get pinned: a round trip must come back as what
// went in, and clipping must clip rather than wrap around into noise.
import assert from 'node:assert/strict';

import { floatToPcm16Base64, pcm16Base64ToFloat, VOICE_RATE_HZ } from './voice-audio';

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

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
