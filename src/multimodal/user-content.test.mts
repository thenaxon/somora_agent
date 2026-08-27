// Capability-aware attachment packing for the openai-compatible engine
// (2026-08-27). Run: npx tsx src/multimodal/user-content.test.mts
//
// What these protect:
//
// A session that has ever carried an image replays that image on EVERY
// later turn. Before this, the replay was unconditional: switch the
// session to a text-only model and every turn re-sent image_url blocks
// the backend rejects with HTTP 400 — the chosen model never got used,
// somora silently fell back, and the session was permanently unusable
// for text-only models. Reported 2026-08-26 (external, `bcflash`).
//
// The fix degrades what the model cannot process into a text marker.
// The invariants worth asserting:
//   1. No image_url / file part ever reaches a model lacking the cap.
//   2. The marker still names the file — the model must be able to
//      talk about what it cannot see.
//   3. Nothing changes for a capable model (no silent regression for
//      the vision path that already worked).
//   4. When everything degrades to text, the message collapses back to
//      a plain string — the exact shape a text-only backend expects.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAiUserContent, type OpenAiContentPart } from './user-content.ts';
import type { ResolvedAttachment } from '../engine/types.ts';
import type { ModelCapability } from '../config/types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

const TEXT_ONLY: ModelCapability[] = ['text'];
const VISION: ModelCapability[] = ['text', 'image'];
const PDF_NATIVE: ModelCapability[] = ['text', 'image', 'pdf'];

const dir = mkdtempSync(join(tmpdir(), 'somora-usercontent-'));

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngPath = join(dir, 'shot.png');
writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));

const txtPath = join(dir, 'notes.txt');
writeFileSync(txtPath, 'plain notes');

// Minimal one-page PDF, built here so no binary fixture lands in the repo.
function minimalPdf(): Buffer {
  const content = Buffer.from('BT /F1 24 Tf 72 700 Td (somora test page) Tj ET');
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
        '/Resources << /Font << /F1 5 0 R >> >> >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  let out = Buffer.from('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
  });
  const xref = out.length;
  out = Buffer.concat([
    out,
    Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`),
    Buffer.from(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')),
    Buffer.from(
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  ]);
  return out;
}
const pdfPath = join(dir, 'spec.pdf');
writeFileSync(pdfPath, minimalPdf());

const image: ResolvedAttachment = {
  hash: 'h-img', path: pngPath, name: 'shot.png',
  mime: { kind: 'image', mimeType: 'image/png' }, size: 68,
};
const text: ResolvedAttachment = {
  hash: 'h-txt', path: txtPath, name: 'notes.txt',
  mime: { kind: 'text', mimeType: 'text/plain' }, size: 11,
};
const pdf: ResolvedAttachment = {
  hash: 'h-pdf', path: pdfPath, name: 'spec.pdf',
  mime: { kind: 'pdf', mimeType: 'application/pdf' }, size: 591,
};

const parts = (c: string | OpenAiContentPart[]): OpenAiContentPart[] =>
  typeof c === 'string' ? [] : c;
const hasKind = (c: string | OpenAiContentPart[], kind: string): boolean =>
  parts(c).some((p) => p.type === kind);
const allText = (c: string | OpenAiContentPart[]): string =>
  typeof c === 'string' ? c : parts(c).map((p) => (p.type === 'text' ? p.text : '')).join('\n');

async function run(): Promise<void> {
  // ── 1. The reported bug: image at a text-only model ───────────────
  {
    const c = await buildOpenAiUserContent('was ist da drauf?', [image], 'rasterize', TEXT_ONLY);
    check('text-only: no image_url part survives', !hasKind(c, 'image_url'));
    check('text-only: collapses to a plain string', typeof c === 'string');
    check('text-only: marker names the file', allText(c).includes('shot.png'));
    check('text-only: marker names the mime', allText(c).includes('image/png'));
    check('text-only: marker explains why', allText(c).includes('no \'image\' capability'));
    check('text-only: points at analyze_file', allText(c).includes('analyze_file'));
    check('text-only: user text preserved', allText(c).includes('was ist da drauf?'));
    check(
      'text-only: marker precedes the user text',
      allText(c).indexOf('shot.png') < allText(c).indexOf('was ist da drauf?'),
    );
  }

  // ── 2. No regression for a vision model ──────────────────────────
  {
    const c = await buildOpenAiUserContent('was ist da drauf?', [image], 'rasterize', VISION);
    check('vision: image_url part present', hasKind(c, 'image_url'));
    check('vision: stays an array', typeof c !== 'string');
    check('vision: no marker text', !allText(c).includes('not shown'));
    const img = parts(c).find((p) => p.type === 'image_url');
    check(
      'vision: carries the real bytes',
      img?.type === 'image_url' && img.image_url.url === `data:image/png;base64,${PNG_B64}`,
    );
  }

  // ── 3. Text attachments are never affected ───────────────────────
  {
    const c = await buildOpenAiUserContent('siehe anhang', [text], 'rasterize', TEXT_ONLY);
    check('text attachment inlined for text-only model', allText(c).includes('plain notes'));
    check('text attachment keeps its header', allText(c).includes('[Attached notes.txt]'));
  }

  // ── 4. Mixed: the capable part survives, the rest degrades ───────
  {
    const c = await buildOpenAiUserContent('beides', [image, text], 'rasterize', TEXT_ONLY);
    check('mixed/text-only: no image_url', !hasKind(c, 'image_url'));
    check('mixed/text-only: text attachment still inlined', allText(c).includes('plain notes'));
    check('mixed/text-only: image marker present', allText(c).includes('shot.png'));

    const v = await buildOpenAiUserContent('beides', [image, text], 'rasterize', VISION);
    check('mixed/vision: image_url survives', hasKind(v, 'image_url'));
    check('mixed/vision: text attachment survives', allText(v).includes('plain notes'));
    check('mixed/vision: no collapse to string', typeof v !== 'string');
  }

  // ── 5. PDF follows the same rule, with its own capability pair ───
  {
    const none = await buildOpenAiUserContent('lies das', [pdf], 'native', TEXT_ONLY);
    check('pdf/text-only: no file part', !hasKind(none, 'file'));
    check('pdf/text-only: no image_url part', !hasKind(none, 'image_url'));
    check('pdf/text-only: marker names both caps', allText(none).includes("'pdf' or 'image'"));

    const native = await buildOpenAiUserContent('lies das', [pdf], 'native', PDF_NATIVE);
    check('pdf/native cap: file part emitted', hasKind(native, 'file'));

    // 'native' mode but the model only has 'image': the file block would
    // be rejected for exactly the reason this whole fix exists, so it
    // must rasterise instead.
    const rast = await buildOpenAiUserContent('lies das', [pdf], 'native', VISION);
    check('pdf/image-only cap: no file part', !hasKind(rast, 'file'));
    check('pdf/image-only cap: rasterised to image_url', hasKind(rast, 'image_url'));
  }

  // ── 6. No attachments at all is untouched ────────────────────────
  {
    const c = await buildOpenAiUserContent('nur text', [], 'rasterize', TEXT_ONLY);
    check('no attachments: plain string through', c === 'nur text');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

await run();
