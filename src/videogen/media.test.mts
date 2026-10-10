// Video input media: every dialect speaks its provider's published format,
// passthrough stays byte for byte what it always sent, and anything a model
// does not take is refused before a request goes out (docs/videogen.md).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaItem } from './media.ts';

// Its own data folder: video jobs land there, and another test file running
// at the same time clears its own.
process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'videogen-media-test');
mkdirSync(process.env.SOMORA_HOME, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { clearCatalogCache } = await import('../media/capabilities.ts');
const { startVideoJob } = await import('./generate.ts');
const { mediaItemFromBytes } = await import('./media.ts');

// ─── a stand-in provider that records what it was sent ─────────────────

interface Seen { url: string; contentType: string; parts?: Array<Record<string, unknown>>; json?: Record<string, unknown>; raw?: string }
let seen: Seen[] = [];
let catalog: unknown = null;
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', async () => {
    if (req.method === 'GET') {
      res.writeHead(catalog ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog ?? {}));
      return;
    }
    const body = Buffer.concat(chunks);
    const ct = String(req.headers['content-type'] ?? '');
    const s: Seen = { url: req.url ?? '', contentType: ct };
    if (ct.startsWith('multipart/form-data')) {
      const fd = await new Response(body, { headers: { 'content-type': ct } }).formData();
      s.parts = [];
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') s.parts.push({ name: k, value: v });
        else {
          const b = Buffer.from(await (v as File).arrayBuffer());
          s.parts.push({ name: k, filename: (v as File).name, type: (v as File).type, sha: createHash('sha256').update(b).digest('hex') });
        }
      }
    } else {
      s.raw = body.toString();
      s.json = JSON.parse(s.raw);
    }
    seen.push(s);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'job-1', name: 'operations/op-1', status: 'queued' }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

beforeEach(() => {
  seen = [];
  catalog = null;
  clearCatalogCache();
  // Every start writes a queued job; clear them so the slot cap never bites.
  rmSync(join(process.env.SOMORA_HOME!, 'video-jobs'), { recursive: true, force: true });
});

function config(model: Record<string, unknown>) {
  return ConfigSchema.parse({
    providers: { p: { engine: 'openai-compatible', baseUrl: base, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
    videoGen: { enabled: true, maxConcurrent: 32, models: [{ name: 'm', provider: 'p', model: 'mod-x', ...model }] },
  });
}

// ─── test files ────────────────────────────────────────────────────────

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A minimal MP4 header (ftyp + moov with mvhd and a track) of `seconds`. */
function mp4(seconds: number): Buffer {
  const box = (type: string, payload: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, payload]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(640 * 65536, 76);
  tkhd.writeUInt32BE(360 * 65536, 80);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
    box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('tkhd', tkhd))])),
  ]);
}
const ref = (i: number) => (i % 2 ? { bytes: JPG, mime: 'image/jpeg', filename: `r${i}.jpg` } : { bytes: PNG, mime: 'image/png', filename: `r${i}.png` });
const item = (type: MediaItem['type'], bytes: Buffer, name: string, extra: { seconds?: number; strength?: number } = {}) => mediaItemFromBytes(type, bytes, name, extra);

async function start(model: Record<string, unknown>, input: Record<string, unknown>) {
  return startVideoJob({ prompt: 'a cat', ...input } as never, config(model));
}

// ─── passthrough: byte for byte what it always sent ────────────────────

test('passthrough sends exactly the parts it always did, for 0 to 4 reference images', async () => {
  const specs = { seconds: 5, aspect_ratio: '16:9', audio: true, seed: 42 };
  for (const n of [0, 1, 2, 3, 4]) {
    seen = [];
    rmSync(join(process.env.SOMORA_HOME!, 'video-jobs'), { recursive: true, force: true });
    const refs = Array.from({ length: n }, (_, i) => ref(i));
    await start({ wire: 'passthrough', defaults: { resolution: '720p' } }, { specs, references: refs });
    const s = seen[0]!;
    assert.equal(s.url, '/v1/vid/create');
    if (n === 0) {
      // The JSON body, untouched — seconds stays a number here.
      assert.equal(s.raw, JSON.stringify({ model: 'mod-x', prompt: 'a cat', resolution: '720p', ...specs }));
      continue;
    }
    const head = [
      { name: 'model', value: 'mod-x' },
      { name: 'prompt', value: 'a cat' },
      { name: 'resolution', value: '720p' },
      { name: 'seconds', value: '5' },
      { name: 'aspect_ratio', value: '16:9' },
      { name: 'audio', value: 'true' },
      { name: 'seed', value: '42' },
    ];
    const file = (name: string, r: ReturnType<typeof ref>) => ({ name, filename: r.filename, type: r.mime, sha: sha(r.bytes) });
    const files = n === 2 ? [file('first_frame', refs[0]!), file('last_frame', refs[1]!)] : refs.map((r) => file('image[]', r));
    assert.deepEqual(s.parts, [...head, ...files], `n=${n}`);
  }
});

test('passthrough media that maps onto the old fields goes out the same way', async () => {
  await start({ wire: 'passthrough' }, { media: [item('last_frame', JPG, 'b.jpg'), item('first_frame', PNG, 'a.png')] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['first_frame', 'last_frame'], 'opening frame first, whatever the order given');
  await assert.rejects(start({ wire: 'passthrough' }, { media: [item('first_frame', PNG, 'a.png'), item('reference_image', JPG, 'r.jpg')] }), /which file is a frame/);
  await assert.rejects(start({ wire: 'passthrough' }, { media: [item('input_video', mp4(3), 'v.mp4')] }), /takes no input_video.*media\.input_video\.field/);
});

// ─── openai: the published /v1/videos format ───────────────────────────

test('openai: the opening frame is input_reference, seconds is a string, a closing frame is refused', async () => {
  await start({ wire: 'openai' }, { references: [ref(0)], specs: { seconds: 8 } });
  const s = seen[0]!;
  assert.equal(s.url, '/v1/videos');
  assert.deepEqual(s.parts!.map((p) => p.name), ['model', 'prompt', 'seconds', 'input_reference']);
  seen = [];
  await start({ wire: 'openai' }, { specs: { seconds: 8, size: '1280x720' } });
  assert.deepEqual(seen[0]!.json, { model: 'mod-x', prompt: 'a cat', seconds: '8', size: '1280x720' });
  await assert.rejects(start({ wire: 'openai' }, { references: [ref(0), ref(1)] }), /takes no last_frame/);
});

test('a config media block is the whole list when there is no catalog', async () => {
  const model = { wire: 'passthrough', media: { input_video: { field: 'video' } } };
  await assert.rejects(start(model, { references: [ref(0)] }), /takes no first_frame — it takes input_video/);
});

test('a model can rename a field in config: openai with a provider that calls the opening frame image', async () => {
  await start({ wire: 'openai', media: { first_frame: { field: 'image', max: 1 }, last_frame: { field: 'end_image', max: 1 } } }, { references: [ref(0), ref(1)] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['image', 'end_image']);
});

// ─── veo: Google's instances / parameters ──────────────────────────────

test('veo: prompt and images in instances, camelCase parameters, no model in the body', async () => {
  await start({ wire: 'veo' }, { references: [ref(0), ref(1)], specs: { seconds: 8, aspect_ratio: '16:9', audio: true, seed: 3 } });
  const s = seen[0]!;
  assert.equal(s.url, '/v1/models/mod-x:predictLongRunning');
  assert.deepEqual(s.json, {
    instances: [{
      prompt: 'a cat',
      image: { bytesBase64Encoded: PNG.toString('base64'), mimeType: 'image/png' },
      lastFrame: { bytesBase64Encoded: JPG.toString('base64'), mimeType: 'image/jpeg' },
    }],
    parameters: { durationSeconds: 8, aspectRatio: '16:9', generateAudio: true, seed: 3 },
  });
  seen = [];
  await start({ wire: 'veo' }, { media: [item('reference_image', PNG, 'a.png'), item('reference_image', JPG, 'b.jpg')] });
  assert.deepEqual((seen[0]!.json!.instances as Array<Record<string, unknown>>)[0]!.referenceImages, [
    { image: { bytesBase64Encoded: PNG.toString('base64'), mimeType: 'image/png' }, referenceType: 'asset' },
    { image: { bytesBase64Encoded: JPG.toString('base64'), mimeType: 'image/jpeg' }, referenceType: 'asset' },
  ]);
  await assert.rejects(start({ wire: 'veo' }, { references: [ref(0), ref(1), ref(0), ref(1)] }), /at most 3/);
});

// ─── JSON transport: providers that take URLs or data: URIs ────────────

test('json transport: data: URIs at the configured fields, dotted paths nest', async () => {
  const media = { input_video: { field: 'input.video_url' }, character_image: { field: 'input.image_url' } };
  await start({ wire: 'passthrough', transport: 'json', media }, { media: [item('input_video', mp4(4), 'clip.mp4'), item('character_image', PNG, 'who.png')] });
  const j = seen[0]!.json!;
  assert.equal(j.model, 'mod-x');
  assert.equal((j.input as Record<string, string>).video_url!.slice(0, 22), 'data:video/mp4;base64,');
  assert.equal((j.input as Record<string, string>).image_url, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.ok(!seen[0]!.raw!.includes('/tmp') && !seen[0]!.raw!.includes('clip.mp4'), 'no local path or file name on the wire');
});

test('json transport: several files of one type become a list', async () => {
  await start({ wire: 'passthrough', transport: 'json', media: { reference_image: { field: 'reference_image_urls', max: 7 } } }, { media: [item('reference_image', PNG, 'a.png'), item('reference_image', JPG, 'b.jpg')] });
  assert.equal((seen[0]!.json!.reference_image_urls as string[]).length, 2);
});

// ─── catalogs that publish accepted_media ──────────────────────────────

test('catalog accepted_media: field picked per dialect, counts and needs enforced, unlisted types refused', async () => {
  catalog = {
    data: [{
      id: 'mod-x',
      accepted_media: {
        input_video: { kind: 'video', min: 1, max: 1, fields: ['video_url'], max_seconds: 10 },
        character_image: { kind: 'image', min: 1, max: 1, fields: ['image_url'] },
        first_frame: { kind: 'image', max: 1, fields: ['image_url', 'start_image_url', 'input_reference', 'first_frame'] },
      },
    }],
  };
  const model = { wire: 'openai', capabilitiesEndpoint: '/video/models' };
  await start(model, { media: [item('input_video', mp4(4), 'v.mp4'), item('character_image', PNG, 'c.png')] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['video_url', 'image_url']);
  await assert.rejects(start(model, { media: [item('input_video', mp4(4), 'v.mp4')] }), /needs 1 × character_image/);
  await assert.rejects(start(model, { media: [item('input_video', mp4(12), 'long.mp4'), item('character_image', PNG, 'c.png')] }), /runs 12\.0 s.*at most 10 s/);
  await assert.rejects(start(model, { media: [item('reference_audio', Buffer.from('ID3\x03\0\0\0\0\0\0', 'latin1'), 'a.mp3')] }), /takes no reference_audio/);
});

test('an empty accepted_media means the model takes no files', async () => {
  catalog = { data: [{ id: 'mod-x', accepted_media: {} }] };
  await assert.rejects(start({ wire: 'passthrough', capabilitiesEndpoint: '/video/models' }, { media: [item('first_frame', PNG, 'a.png')] }), /takes no first_frame — it takes no input files/);
});

test('catalog first_frame offers input_reference: the openai dialect picks it', async () => {
  catalog = { data: [{ id: 'mod-x', accepted_media: { first_frame: { kind: 'image', max: 1, fields: ['image_url', 'input_reference'] } } }] };
  await start({ wire: 'openai', capabilitiesEndpoint: '/video/models' }, { references: [ref(0)] });
  assert.equal(seen[0]!.parts!.at(-1)!.name, 'input_reference');
});

test('passthrough with a catalog that names the old fields still sends the old bytes', async () => {
  catalog = { data: [{ id: 'mod-x', accepted_media: {
    first_frame: { kind: 'image', max: 1, fields: ['image_url', 'start_image_url', 'input_reference', 'first_frame'] },
    last_frame: { kind: 'image', max: 1, fields: ['end_image_url', 'last_frame'] },
  } }] };
  const model = { wire: 'passthrough', capabilitiesEndpoint: '/video/models' };
  await start(model, { references: [ref(0)] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['image[]'], 'one opening frame stays image[]');
  seen = [];
  await start(model, { references: [ref(0), ref(1)] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['first_frame', 'last_frame']);
});

test('catalog keyframe form and anchor_fps: frame numbers at the type\'s rate, JSON chosen on its own', async () => {
  catalog = { data: [{ id: 'mod-x', accepted_media: {
    reference_image: { kind: 'image', max: 9, fields: ['reference_image_urls'] },
    reference_video: { kind: 'video', max: 3, fields: ['reference_video_urls'], max_seconds: 15, min_seconds: 2 },
    keyframe_image: { kind: 'image', max: 8, fields: ['images'], anchor_fps: 24, item: { url: 'image_url', frame: 'frame', frame_unit: 'frames', strength: 'strength', strength_range: [0, 1] } },
  } }] };
  const model = { wire: 'passthrough', capabilitiesEndpoint: '/video/models' };
  await start(model, { media: [item('reference_image', PNG, 'a.png'), item('keyframe_image', JPG, 'k.jpg', { seconds: 2, strength: 0.5 })] });
  const j = seen[0]!.json!;
  assert.deepEqual(j.images, [{ image_url: `data:image/jpeg;base64,${JPG.toString('base64')}`, frame: 48, strength: 0.5 }]);
  assert.deepEqual(j.reference_image_urls, [`data:image/png;base64,${PNG.toString('base64')}`], 'a list, since the model takes up to nine');
  await assert.rejects(start(model, { media: [item('reference_video', mp4(1), 'short.mp4')] }), /needs at least 2 s/);
  await assert.rejects(start(model, { media: [item('keyframe_image', JPG, 'k.jpg', { seconds: 1, strength: 1.5 })] }), /strength 1\.5 is outside 0–1/);
  seen = [];
  await start(model, { media: [item('reference_image', PNG, 'a.png'), item('reference_image', JPG, 'b.jpg')] });
  assert.deepEqual(seen[0]!.parts!.slice(2).map((p) => p.name), ['reference_image_urls', 'reference_image_urls'], 'without keyframes: multipart parts under the catalog field');
});

// ─── keyframes ─────────────────────────────────────────────────────────

test('keyframes: seconds as given, or a frame number from fps; refused without fps or format', async () => {
  const kf = { keyframe_image: { field: 'images', item: { url: 'image_url', frame: 'start_frame_num', strength: 'strength' } } };
  await start({ wire: 'passthrough', transport: 'json', fps: 24, media: kf }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 2.5, strength: 0.8 })] });
  assert.deepEqual(seen[0]!.json!.images, [{ image_url: `data:image/png;base64,${PNG.toString('base64')}`, start_frame_num: 60, strength: 0.8 }]);
  await assert.rejects(start({ wire: 'passthrough', transport: 'json', media: kf }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 1 })] }), /frame rate is unknown/);
  const bySeconds = { keyframe_image: { field: 'keyframes', item: { url: 'uri', seconds: 'seconds' } } };
  seen = [];
  await start({ wire: 'passthrough', transport: 'json', media: bySeconds }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 3 })] });
  assert.deepEqual(seen[0]!.json!.keyframes, [{ uri: `data:image/png;base64,${PNG.toString('base64')}`, seconds: 3 }]);
  await assert.rejects(start({ wire: 'passthrough', transport: 'json', media: bySeconds }, { media: [item('keyframe_image', PNG, 'k.png')] }), /needs seconds/);
  await assert.rejects(start({ wire: 'passthrough', transport: 'multipart', media: bySeconds }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 1 })] }), /needs transport: json/);
  seen = [];
  await start({ wire: 'passthrough', media: bySeconds }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 1 })] });
  assert.ok(seen[0]!.json?.keyframes, 'without a configured transport a keyframe request goes as JSON');
  await assert.rejects(start({ wire: 'veo', media: bySeconds }, { media: [item('keyframe_image', PNG, 'k.png', { seconds: 1 })] }), /no keyframes/);
  await assert.rejects(start({ wire: 'passthrough' }, { media: [item('first_frame', PNG, 'k.png', { seconds: 1 })] }), /seconds belongs to keyframes only/);
});

// ─── files ─────────────────────────────────────────────────────────────

test('a file of the wrong kind, an unknown file, or both input fields are refused', async () => {
  await assert.rejects(start({ wire: 'passthrough' }, { media: [item('first_frame', mp4(2), 'v.mp4')] }), /is a video, but first_frame takes an image/);
  assert.throws(() => mediaItemFromBytes('first_frame', Buffer.from('%PDF-1.7 hello'), 'doc.pdf'), /application\/pdf/);
  assert.throws(() => mediaItemFromBytes('first_frame', Buffer.alloc(0), 'empty.png'), /empty/);
  await assert.rejects(start({ wire: 'passthrough' }, { references: [ref(0)], media: [item('first_frame', PNG, 'a.png')] }), /not both/);
  const v = mediaItemFromBytes('input_video', mp4(6.5), '/home/x/clip.mp4');
  assert.equal(v.filename, 'clip.mp4');
  assert.equal(v.durationSec, 6.5);
});
