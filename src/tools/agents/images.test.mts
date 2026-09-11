// Handing a picture to another agent: the path → attachment step.
//
// Run: npx tsx src/tools/agents/images.test.mts
//
// The A2A tools take file PATHS, because that is what an agent has —
// image_generate returns one, a browser screenshot returns one. The
// bytes go up through POST /attachments like any client's would, and
// the ref rides on the send. What is worth pinning here is the part a
// model gets wrong: a relative path, a directory, a file that is not
// there, too many at once — each has to fail with something the model
// can act on, and none of them may reach the server as a half-upload.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_IMAGES_PER_MESSAGE, uploadLocalAttachments } from './images.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const dir = mkdtempSync(join(tmpdir(), 'somora-a2a-img-'));
const png = join(dir, 'shapes.png');
writeFileSync(png, PNG);
writeFileSync(join(dir, 'empty.png'), '');
mkdirSync(join(dir, 'a-folder'));

// A stand-in for POST /attachments: records what arrived, answers the
// single object the real route answers with.
const received: Array<{ name: string | undefined; bytes: Buffer; contentType: string | undefined }> = [];
let status = 200;
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const bytes = Buffer.concat(chunks);
    received.push({
      name: req.headers['x-somora-filename'] as string | undefined,
      bytes,
      contentType: req.headers['content-type'] as string | undefined,
    });
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file too large (attachments.maxImageBytes)' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hash: `sha256-${bytes.length}`,
      name: decodeURIComponent((req.headers['x-somora-filename'] as string) ?? 'unnamed'),
      mime: 'image/png',
      kind: 'image',
      size: bytes.length,
    }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// ── the bytes of the file arrive, and the ref comes back ─────────────
{
  const refs = await uploadLocalAttachments([png], base);
  check('one ref per path', refs.length === 1, String(refs.length));
  check('the ref carries the store\'s answer', refs[0]?.kind === 'image' && refs[0]?.size === PNG.length, JSON.stringify(refs[0]));
  check('the real bytes went up', received[0]?.bytes.equals(PNG) === true, `${received[0]?.bytes.length} bytes`);
  check('the filename travels in the header', decodeURIComponent(received[0]?.name ?? '') === 'shapes.png', String(received[0]?.name));
}

// ── order is kept: the model said image 1 then image 2 ───────────────
{
  received.length = 0;
  const second = join(dir, 'zweite.png');
  writeFileSync(second, Buffer.concat([PNG, PNG]));
  const refs = await uploadLocalAttachments([png, second], base);
  check('both uploaded in order', refs.length === 2 && refs[0]!.size < refs[1]!.size, JSON.stringify(refs.map((r) => r.size)));
}

// ── things a model gets wrong, each with an actionable message ───────
for (const [name, path, expect] of [
  ['a relative path is refused', 'shapes.png', /absolute/i],
  ['a missing file is refused', join(dir, 'nope.png'), /cannot read/i],
  ['a directory is refused', join(dir, 'a-folder'), /directory/i],
  ['an empty file is refused', join(dir, 'empty.png'), /empty/i],
] as const) {
  let msg = '';
  try {
    await uploadLocalAttachments([path], base);
  } catch (e) {
    msg = (e as Error).message;
  }
  check(name, expect.test(msg), msg);
}

// ── the per-message cap is checked before anything is uploaded ───────
{
  received.length = 0;
  let msg = '';
  try {
    await uploadLocalAttachments(Array(MAX_IMAGES_PER_MESSAGE + 1).fill(png), base);
  } catch (e) {
    msg = (e as Error).message;
  }
  check('too many images is refused', /exceed the per-message cap/.test(msg), msg);
  check('and nothing was uploaded', received.length === 0, String(received.length));
}

// ── a server-side refusal keeps its reason ───────────────────────────
{
  status = 413;
  let msg = '';
  try {
    await uploadLocalAttachments([png], base);
  } catch (e) {
    msg = (e as Error).message;
  }
  status = 200;
  check('the store\'s reason survives', /maxImageBytes/.test(msg) && /413/.test(msg), msg);
}

server.close();
console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
