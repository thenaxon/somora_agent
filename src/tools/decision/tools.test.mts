// decision_evaluate as a tool: visibility, images field per model, image reading and scaling.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ConfigSchema } from '../../config/types.ts';
import { decisionEvaluate } from './tools.ts';
import type { ToolContext } from '../types.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');

let received: { images?: string[] } = {};
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d)).on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.endsWith('/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'clef', max_input_tokens: 65536 }] })); return; }
    received = JSON.parse(raw);
    res.end(JSON.stringify({ model: 'clef', answers: { red: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 3400, output_tokens: 0 } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function ctx(capabilities: ('text' | 'image')[] | null): ToolContext {
  const config = ConfigSchema.parse({
    providers: {},
    ...(capabilities ? { decisions: { model: 'clef', models: [{ name: 'clef', baseUrl: base, model: 'clef', capabilities }] } } : {}),
  });
  return { agent: 'ada', session: 'main', config } as unknown as ToolContext;
}
const question = { red: { type: 'boolean' as const, instructions: 'Is there a red car?' } };

test('hidden without a decision model; visible with one', async () => {
  assert.equal(await decisionEvaluate.available!(ctx(null)), false);
  assert.equal(await decisionEvaluate.available!(ctx(['text'])), true);
});

test('the images field and sentence exist only for a model that reads images', () => {
  const withImages = decisionEvaluate.forContext!(ctx(['text', 'image']));
  const textOnly = decisionEvaluate.forContext!(ctx(['text']));
  assert.ok((withImages.jsonSchema!.properties as Record<string, unknown>).images);
  assert.equal((textOnly.jsonSchema!.properties as Record<string, unknown>).images, undefined);
  assert.match(withImages.description!, /Images: give file paths/);
  assert.match(textOnly.description!, /reads text only/);
  assert.match(withImages.description!, /not a "no"/);
});

test('a 6000×4000 photo is scaled to the model edge before it goes out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-dec-'));
  const big = join(dir, 'big.jpg');
  writeFileSync(big, await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#c00' } }).jpeg().toBuffer());
  const out = await decisionEvaluate.handler({ state: 'photo', questions: question, images: [big] }, ctx(['text', 'image']));
  assert.equal(out.status, 'ok');
  const meta = await sharp(Buffer.from(received.images![0]!, 'base64')).metadata();
  assert.equal(Math.max(meta.width!, meta.height!), 2048, 'longest side = attachments.maxImageEdge');
  assert.ok(!received.images![0]!.startsWith('data:'), 'raw base64');
});

test('images are refused when not allowed, not an image, blocked, or the model reads text only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-dec-'));
  const txt = join(dir, 'notes.txt');
  writeFileSync(txt, 'hello');
  const notImage = await decisionEvaluate.handler({ state: 's', questions: question, images: [txt] }, ctx(['text', 'image']));
  assert.equal(notImage.status === 'unavailable' && notImage.reason, 'unsupported-input');
  assert.match((notImage as { detail: string }).detail, /PNG, JPEG or WebP only/);
  const blocked = await decisionEvaluate.handler({ state: 's', questions: question, images: [join(homedir(), '.ssh', 'id_ed25519')] }, ctx(['text', 'image']));
  assert.equal(blocked.status, 'unavailable', 'a private key is never read');
  const textOnly = await decisionEvaluate.handler({ state: 's', questions: question, images: [txt] }, ctx(['text']));
  assert.equal(textOnly.status === 'unavailable' && textOnly.reason, 'images-unsupported');
  const off = await decisionEvaluate.handler({ state: 's', questions: question }, ctx(null));
  assert.equal(off.status === 'unavailable' && off.reason, 'not-configured');
});

test('the Zod schema rejects malformed questions before anything is sent', () => {
  const parse = (v: unknown) => decisionEvaluate.inputSchema.safeParse(v).success;
  assert.equal(parse({ state: 's', questions: { a: { type: 'choice', criteria: { only: 'one' } } } }), false, 'choice needs 2+');
  assert.equal(parse({ state: 's', questions: { a: { type: 'score', criteria: ['x'] } } }), false, 'score needs 2+');
  assert.equal(parse({ state: 's', questions: { a: { type: 'noul' } } }), false, 'agents say boolean, not noul');
  assert.equal(parse({ state: 's', questions: {} }), false);
  assert.equal(parse({ state: { any: 'json' }, questions: { a: { type: 'boolean' } } }), true);
});
