// End-to-end replay check for capability-aware attachment packing
// (2026-08-27). Run: npx tsx src/engine/openai-history-attachments.test.mts
//
// user-content.test.mts covers the packing function in isolation. This
// one walks the path the reported bug actually took: a persisted
// session whose user_message carries an attachment REF, replayed
// through buildMessages against a real attachment store on disk.
//
// The reported failure (2026-08-26, external): a session with five
// older image entries, switched to a text-only model, sending plain
// text. Every turn re-sent the historical image_url blocks, the
// endpoint answered HTTP 400, and somora fell back to another model —
// so the model the user picked was never actually used.
//
// SOMORA_HOME is pointed at a temp dir BEFORE the modules load, which
// is why the imports below are dynamic: the attachment store resolves
// its directory once at import time.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'somora-home-'));
process.env.SOMORA_HOME = home;
mkdirSync(join(home, 'attachments'), { recursive: true });

const { buildMessages } = await import('./openai-compatible.ts');
type NormalizedEvent = import('../types/events.ts').NormalizedEvent;
type ModelCapability = import('../config/types.ts').ModelCapability;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const HASH = 'deadbeef';
writeFileSync(join(home, 'attachments', `${HASH}.png`), Buffer.from(PNG_B64, 'base64'));

const TEXT_ONLY: ModelCapability[] = ['text'];
const VISION: ModelCapability[] = ['text', 'image'];

let clock = 1000;
const ts = (): number => ++clock;

/** The shape the bug needs: an older turn that carried an image, then
 *  ordinary text turns on top of it. */
function sessionWithImage(hash: string): NormalizedEvent[] {
  return [
    {
      kind: 'user_message', ts: ts(), text: 'schau dir das an',
      attachments: [{ hash, name: 'shot.png', mime: 'image/png', size: 68 }],
    },
    { kind: 'assistant_message', ts: ts(), engine: 'openai-compatible', text: 'Sieht gut aus.' },
    { kind: 'user_message', ts: ts(), text: 'und jetzt nur noch text' },
  ] as NormalizedEvent[];
}

const dump = (msgs: unknown[]): string => JSON.stringify(msgs);

async function run(): Promise<void> {
  // ── 1. Text-only model: the session stays sendable ────────────────
  {
    const msgs = await buildMessages('SYS', sessionWithImage(HASH), undefined, 'rasterize', TEXT_ONLY);
    const raw = dump(msgs);
    check('text-only: no image_url anywhere in the request', !raw.includes('image_url'));
    check('text-only: no base64 payload leaked in', !raw.includes(PNG_B64.slice(0, 24)));
    check('text-only: the attachment is still accounted for', raw.includes('shot.png'));
    check('text-only: the turn that carried it kept its text', raw.includes('schau dir das an'));
    check('text-only: later text turn intact', raw.includes('und jetzt nur noch text'));
    check('text-only: system prompt first', (msgs[0] as { role: string }).role === 'system');
  }

  // ── 2. Vision model: unchanged, the image really is sent ──────────
  {
    const msgs = await buildMessages('SYS', sessionWithImage(HASH), undefined, 'rasterize', VISION);
    const raw = dump(msgs);
    check('vision: image_url present', raw.includes('image_url'));
    check('vision: real bytes present', raw.includes(PNG_B64.slice(0, 24)));
    check('vision: no not-shown marker', !raw.includes('not shown'));
  }

  // ── 3. Attachment deleted from disk: pre-existing degradation ─────
  //     Pinned here because this fix rewrites the branch around it.
  {
    const msgs = await buildMessages('SYS', sessionWithImage('nosuchhash'), undefined, 'rasterize', VISION);
    const raw = dump(msgs);
    check('stale ref: falls back to a marker', raw.includes('Attachments lost from disk'));
    check('stale ref: user text survives', raw.includes('schau dir das an'));
    check('stale ref: no broken image part', !raw.includes('image_url'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(home, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

await run();
